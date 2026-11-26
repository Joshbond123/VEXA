"""VEXA Kaggle GPU runtime.

Runs inside a private Kaggle script kernel. The Worker injects CONFIG above this
file, registers the session, loads Qwen with llama.cpp across both T4 GPUs, proves
the model answers, then long-polls the Worker for OpenAI-compatible jobs.
"""
import hashlib
import http.client
import json
import os
import queue
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request

try:
    CONFIG  # injected by the Worker
except NameError:
    CONFIG = {}

WORKER = str(CONFIG.get("workerUrl", "")).rstrip("/")
RUNTIME_KEY = CONFIG.get("runtimeKey", "")
PORT = 8080
LLAMA_DIR = "/tmp/vexa-llama"

runtime_token = None
stop_event = threading.Event()
ready_event = threading.Event()
log_queue = queue.Queue()
active_jobs = 0
active_lock = threading.Lock()
server_proc = None
server_log = []
server_state = {"gpuLayers": None, "totalLayers": None, "error": None}
last_heartbeat_ok = time.time()


class ApiError(Exception):
    def __init__(self, status, body):
        super().__init__(f"HTTP {status}: {body[:300]}")
        self.status = status
        self.body = body


def _http(url, payload=None, headers=None, timeout=30, method=None):
    data = json.dumps(payload).encode() if payload is not None else None
    hdrs = {"content-type": "application/json", "user-agent": "vexa-runtime/3.0"}
    hdrs.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method or ("POST" if data is not None else "GET"))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
        return json.loads(raw.decode() or "{}")
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", "replace")
        raise ApiError(err.code, body)
    except (urllib.error.URLError, TimeoutError, socket.timeout) as err:
        raise ApiError(0, f"network error: {err}")


def api(path, payload=None, timeout=30, retries=2, token=None):
    last = None
    for attempt in range(retries + 1):
        try:
            return _http(
                WORKER + path,
                payload,
                {"authorization": f"Bearer {token or runtime_token or RUNTIME_KEY}"},
                timeout,
            )
        except ApiError as err:
            last = err
            if err.status in (400, 401, 403, 404, 409):
                raise
            if attempt < retries:
                time.sleep(1.5 * (attempt + 1))
    raise last


def log(message, level="info"):
    line = f"[{time.strftime('%H:%M:%S')}] {message}"
    print(line, flush=True)
    server_log.append(line)
    if len(server_log) > 400:
        del server_log[:200]
    log_queue.put({"ts": int(time.time() * 1000), "level": level, "message": str(message)[:2000]})


def phase(name, detail="", progress=None, extra=None):
    payload = {"phase": name, "detail": detail}
    if progress is not None:
        payload["progress"] = float(progress)
    if extra:
        payload.update(extra)
    try:
        api("/api/runtime/phase", payload, retries=1)
    except Exception as err:
        log(f"phase update failed: {err}", "warn")


def gpu_stats():
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=index,name,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=15,
        ).stdout
    except Exception:
        return []
    gpus = []
    for line in out.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 5:
            continue
        def num(v):
            try:
                return float(v)
            except Exception:
                return None
        gpus.append({
            "index": int(num(parts[0]) or 0),
            "name": parts[1],
            "totalMiB": num(parts[2]),
            "usedMiB": num(parts[3]),
            "utilPct": num(parts[4]),
            "tempC": num(parts[5]) if len(parts) > 5 else None,
            "powerW": num(parts[6]) if len(parts) > 6 else None,
        })
    return gpus


def log_sender():
    while not stop_event.is_set():
        batch = []
        deadline = time.time() + 1.0
        while len(batch) < 40 and time.time() < deadline:
            try:
                batch.append(log_queue.get(timeout=max(0.05, deadline - time.time())))
            except queue.Empty:
                break
        if batch:
            try:
                api("/api/runtime/log", {"lines": batch}, retries=1, timeout=15)
            except Exception:
                pass
        else:
            time.sleep(0.2)


def heartbeat_loop():
    global last_heartbeat_ok
    while not stop_event.is_set():
        try:
            payload = {
                "phase": CONFIG.get("_phase") or ("ready" if ready_event.is_set() else "starting"),
                "gpus": gpu_stats(),
                "activeJobs": active_jobs,
                "progress": CONFIG.get("_progress"),
                "detail": CONFIG.get("_detail", ""),
                "server": dict(server_state),
            }
            res = api("/api/runtime/heartbeat", payload, retries=1, timeout=20)
            last_heartbeat_ok = time.time()
            if res.get("stop"):
                log(f"stop requested: {res.get('reason') or 'control plane'}", "warn")
                stop_event.set()
                break
        except Exception as err:
            if time.time() - last_heartbeat_ok > 180:
                log(f"control plane unreachable for 3 minutes ({err}); exiting to protect quota", "error")
                stop_event.set()
                break
        stop_event.wait(5)


def set_phase(name, detail="", progress=None, extra=None):
    CONFIG["_phase"] = name
    CONFIG["_detail"] = detail
    CONFIG["_progress"] = progress
    phase(name, detail, progress, extra)


def find_input_file(name):
    slug = str(CONFIG.get("dataset", "")).split("/")[-1]
    direct = os.path.join("/kaggle/input", slug, name)
    if os.path.exists(direct):
        return direct
    for root, _dirs, files in os.walk("/kaggle/input"):
        if name in files:
            return os.path.join(root, name)
    return None


def prepare_llama(dataset_dir):
    os.makedirs(LLAMA_DIR, exist_ok=True)
    copied = 0
    for entry in os.listdir(dataset_dir):
        if entry == "llama-server" or entry.startswith("lib") and ".so" in entry:
            src = os.path.join(dataset_dir, entry)
            if not os.path.isfile(src):
                continue
            dst = os.path.join(LLAMA_DIR, entry)
            if not os.path.exists(dst) or os.path.getsize(dst) != os.path.getsize(src):
                shutil.copy2(src, dst)
                copied += 1
            if entry == "llama-server" or entry.endswith(".so") or ".so." in entry:
                os.chmod(dst, 0o755)
    log(f"llama runtime staged in {LLAMA_DIR} ({copied} files copied)")
    return os.path.join(LLAMA_DIR, "llama-server")


def verify_model(model_path):
    expected_bytes = int(CONFIG.get("modelBytes") or 0)
    expected_sha = str(CONFIG.get("modelSha256") or "")
    size = os.path.getsize(model_path)
    if expected_bytes and size != expected_bytes:
        raise RuntimeError(f"model size mismatch: {size} != {expected_bytes}")
    with open(model_path, "rb") as fh:
        magic = fh.read(4)
    if magic != b"GGUF":
        raise RuntimeError("model file is not a GGUF file")
    digest = None
    if expected_sha and CONFIG.get("verifyFull"):
        h = hashlib.sha256()
        read = 0
        started = time.time()
        with open(model_path, "rb") as fh:
            for chunk in iter(lambda: fh.read(64 * 1024 * 1024), b""):
                h.update(chunk)
                read += len(chunk)
                if expected_bytes:
                    set_phase("loading", "verifying model integrity", min(0.15, 0.15 * read / expected_bytes))
        digest = h.hexdigest()
        if digest != expected_sha:
            raise RuntimeError("model SHA-256 mismatch")
        log(f"full SHA-256 verified in {time.time() - started:.1f}s")
    else:
        with open(model_path, "rb") as fh:
            head = hashlib.sha256(fh.read(32 * 1024 * 1024)).hexdigest()
            fh.seek(max(0, size - 32 * 1024 * 1024))
            tail = hashlib.sha256(fh.read(32 * 1024 * 1024)).hexdigest()
        digest = f"head:{head[:16]} tail:{tail[:16]}"
        log("model quick-verified (size + GGUF magic + head/tail digests)")
    return {"bytes": size, "sha256": digest}


def read_server_output(proc):
    layer_re = re.compile(r"offloaded\s+(\d+)\s*/\s*(\d+)\s+layers to GPU")
    repeat_re = re.compile(r"offloading\s+(\d+)\s+repeating layers")
    err_re = re.compile(r"(error|failed|cuda error|out of memory|invalid argument)", re.I)
    for raw in iter(proc.stdout.readline, b""):
        line = raw.decode("utf-8", "replace").rstrip()
        if not line:
            continue
        if line not in server_log[-3:]:
            log(line, "warn" if err_re.search(line) else "info")
        match = layer_re.search(line)
        if match:
            server_state["gpuLayers"] = int(match.group(1))
            server_state["totalLayers"] = int(match.group(2))
        else:
            partial = repeat_re.search(line)
            if partial:
                server_state["gpuLayers"] = int(partial.group(1))
        if "out of memory" in line.lower() or "cuda error" in line.lower():
            server_state["error"] = line[:500]


def log_ldd(path, env=None):
    try:
        out = subprocess.run(["ldd", path], capture_output=True, text=True, timeout=30, env=env).stdout
        missing = [line.strip().split(" ")[0] for line in out.splitlines() if "not found" in line]
        name = os.path.basename(path)
        if missing:
            log(f"ldd {name}: unresolved {', '.join(missing)}", "warn")
        else:
            log(f"ldd {name}: all dependencies resolved")
    except Exception as err:
        log(f"ldd {os.path.basename(path)} failed: {err}", "warn")


def ensure_cublas(dirs):
    names = ("libcublas.so.12", "libcublasLt.so.12")
    if all(any(os.path.exists(os.path.join(d, n)) for d in dirs) for n in names):
        return dirs
    log("libcublas is missing; installing nvidia-cublas-cu12", "warn")
    try:
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "-q", "--no-warn-script-location", "nvidia-cublas-cu12"],
            timeout=900, check=False,
        )
    except Exception as err:
        log(f"pip install nvidia-cublas-cu12 failed: {err}", "warn")
    try:
        import site
        for root in site.getsitepackages() + [site.getusersitepackages()]:
            candidate = os.path.join(root, "nvidia", "cublas", "lib")
            if os.path.isdir(candidate) and candidate not in dirs:
                dirs.insert(0, candidate)
    except Exception:
        pass
    return dirs


def start_server(server_path, model_path):
    global server_proc
    env = dict(os.environ)
    cuda_dirs = [LLAMA_DIR, "/usr/local/cuda/lib64", "/usr/local/cuda-12/lib64", "/usr/local/cuda-12.2/lib64", "/usr/local/cuda-12.4/lib64"]
    try:
        import site
        for root in site.getsitepackages() + [site.getusersitepackages()]:
            for extra in ("nvidia/cublas/lib", "nvidia/cuda_runtime/lib"):
                candidate = os.path.join(root, extra)
                if os.path.isdir(candidate):
                    cuda_dirs.append(candidate)
    except Exception:
        pass
    cuda_dirs = ensure_cublas(cuda_dirs)
    env["LD_LIBRARY_PATH"] = ":".join(cuda_dirs + [env.get("LD_LIBRARY_PATH", "")]).strip(":")
    env["CUDA_VISIBLE_DEVICES"] = "0,1"
    log_ldd(os.path.join(LLAMA_DIR, "libggml-cuda.so"), env)
    base = [
        server_path,
        "-m", model_path,
        "--host", "127.0.0.1",
        "--port", str(PORT),
        "-ngl", "99",
        "--split-mode", "layer",
        "--tensor-split", "1,1",
        "--main-gpu", "0",
        "-c", str(int(CONFIG.get("ctx") or 32768)),
        "-np", str(int(CONFIG.get("parallel") or 2)),
        "-t", "4",
        "--jinja",
        "--no-warmup",
        "--no-webui",
        "--metrics",
        "--alias", str(CONFIG.get("servedModel") or "vexa"),
    ]
    # Fold reasoning into message.content: most OpenAI clients ignore reasoning_content.
    reasoning = ["--reasoning-format", "none"]
    spec = ["--spec-type", "draft-mtp", "--spec-draft-n-max", "2"]
    variants = [base + reasoning + spec, base + reasoning, base + spec, base]
    for index, args in enumerate(variants):
        log("starting llama-server: " + " ".join(args[1:]))
        proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, bufsize=0)
        server_proc = proc
        threading.Thread(target=read_server_output, args=(proc,), daemon=True).start()
        deadline = time.time() + 8
        while time.time() < deadline:
            if proc.poll() is not None:
                break
            if server_state.get("gpuLayers"):
                break
            time.sleep(0.5)
        if proc.poll() is None:
            return proc
        log(f"llama-server exited during startup (code {proc.returncode}); retrying variant {index + 2}/{len(variants)}", "warn")
        server_state["error"] = None
        time.sleep(1)
    raise RuntimeError("llama-server failed to start with every supported flag set")


def monitor_loading(proc, model_bytes):
    expected_mib = max(1.0, model_bytes / (1024 * 1024))
    while not ready_event.is_set() and proc.poll() is None:
        gpus = gpu_stats()
        used = sum((g.get("usedMiB") or 0) for g in gpus)
        progress = min(0.95, max(0.05, used / expected_mib))
        set_phase("loading", f"loading weights into VRAM ({used:.0f}/{expected_mib:.0f} MiB)", progress)
        time.sleep(3)


def wait_health(timeout=900):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if server_proc and server_proc.poll() is not None:
            raise RuntimeError("llama-server exited while loading")
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=5) as resp:
                if resp.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(2)
    raise RuntimeError("llama-server did not become healthy within the startup timeout")


def server_models():
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/v1/models", timeout=10) as resp:
            return json.loads(resp.read().decode())
    except Exception:
        return {}


def _completion(payload):
    req = urllib.request.Request(
        f"http://127.0.0.1:{PORT}/v1/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=300) as resp:
        return json.loads(resp.read().decode())


def selftest():
    model = str(CONFIG.get("servedModel") or "vexa")
    base = {"model": model, "temperature": 0, "stream": False}
    attempts = [
        {**base, "messages": [{"role": "user", "content": "Reply with exactly one word: READY"}],
         "max_tokens": 32, "chat_template_kwargs": {"enable_thinking": False}},
        {**base, "messages": [{"role": "user", "content": "Say READY"}],
         "max_tokens": 128, "chat_template_kwargs": {"enable_thinking": False}},
        {**base, "messages": [{"role": "user", "content": "Say READY"}], "max_tokens": 128},
    ]
    last = None
    for payload in attempts:
        started = time.time()
        try:
            result = _completion(payload)
        except Exception as err:
            last = {"error": str(err)[:300]}
            continue
        elapsed_ms = (time.time() - started) * 1000
        message = {}
        try:
            message = result["choices"][0]["message"] or {}
        except Exception:
            pass
        # Thinking models may spend the whole budget on reasoning tokens.
        content = (message.get("content") or message.get("reasoning_content") or "").strip()
        if content:
            # The first completion pays CUDA graph/JIT warm-up, so time a second pass.
            try:
                warm_started = time.time()
                warm = _completion(payload)
                warm_message = (warm.get("choices") or [{}])[0].get("message") or {}
                if (warm_message.get("content") or warm_message.get("reasoning_content") or "").strip():
                    result = warm
                    elapsed_ms = (time.time() - warm_started) * 1000
                    content = (warm_message.get("content") or warm_message.get("reasoning_content") or "").strip()
            except Exception as err:
                log(f"warm-up measurement skipped: {err}", "warn")
            timings = result.get("timings") or {}
            return {
                "ttftMs": round(elapsed_ms, 1),
                "tokPerSec": round(float(timings.get("predicted_per_second") or 0), 2),
                "content": content[:120],
                "usage": result.get("usage") or {},
            }
        last = result
    raise RuntimeError("self-test returned an empty completion: " + json.dumps(last)[:400])


def flush(job_id, chunks, seq):
    if not chunks:
        return False, seq
    res = api(f"/api/runtime/jobs/{job_id}/chunk", {"chunks": chunks, "seq": seq}, retries=1, timeout=30)
    return bool(res.get("cancel")), seq + len(chunks)


def stream_job(job_id, body):
    conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=1800)
    conn.request("POST", "/v1/chat/completions", json.dumps(body),
                 {"content-type": "application/json", "accept": "text/event-stream"})
    resp = conn.getresponse()
    if resp.status != 200:
        raise RuntimeError(f"llama-server HTTP {resp.status}: {resp.read().decode('utf-8', 'replace')[:800]}")
    chunks, seq, last = [], 0, time.time()
    usage, cancelled = None, False
    for raw in resp:
        line = raw.decode("utf-8", "replace").strip()
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        chunks.append(data)
        if '"usage"' in data:
            try:
                usage = json.loads(data).get("usage") or usage
            except Exception:
                pass
        if len(chunks) >= 8 or time.time() - last >= 0.04:
            cancelled, seq = flush(job_id, chunks, seq)
            chunks, last = [], time.time()
            if cancelled:
                break
    if chunks and not cancelled:
        flush(job_id, chunks, seq)
    conn.close()
    api(f"/api/runtime/jobs/{job_id}/done", {"usage": usage, "cancelled": cancelled}, retries=2)


def blocking_job(job_id, body):
    req = urllib.request.Request(
        f"http://127.0.0.1:{PORT}/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=1800) as resp:
        result = json.loads(resp.read().decode())
    api(f"/api/runtime/jobs/{job_id}/done", {
        "result": result,
        "usage": result.get("usage"),
        "timings": result.get("timings"),
    }, retries=2)


def run_job(job):
    global active_jobs
    with active_lock:
        active_jobs += 1
    job_id = job["id"]
    body = dict(job.get("body") or {})
    stream = bool(job.get("stream"))
    body["model"] = str(CONFIG.get("servedModel") or body.get("model") or "vexa")
    body["stream"] = stream
    if stream:
        body.setdefault("stream_options", {"include_usage": True})
    else:
        body.pop("stream_options", None)
    try:
        if stream:
            stream_job(job_id, body)
        else:
            blocking_job(job_id, body)
    except Exception as err:
        log(f"job {job_id} failed: {err}", "error")
        try:
            api(f"/api/runtime/jobs/{job_id}/error", {"error": str(err)[:800]}, retries=1)
        except Exception:
            pass
    finally:
        with active_lock:
            active_jobs -= 1


def poll_loop(slot):
    while not stop_event.is_set():
        try:
            res = api(f"/api/runtime/poll?slot={slot}&wait=25", None, timeout=40, retries=1)
        except ApiError as err:
            if err.status in (401, 403, 404):
                log(f"control plane rejected the runtime token ({err.status})", "error")
                stop_event.set()
                return
            time.sleep(2)
            continue
        except Exception:
            time.sleep(2)
            continue
        if res.get("stop"):
            log("control plane requested shutdown", "warn")
            stop_event.set()
            return
        job = res.get("job")
        if job:
            run_job(job)
        else:
            time.sleep(0.2)


def shutdown(reason):
    stop_event.set()
    log(f"shutdown: {reason}", "warn")
    deadline = time.time() + 600
    while time.time() < deadline:
        with active_lock:
            if active_jobs == 0:
                break
        time.sleep(1)
    if server_proc and server_proc.poll() is None:
        server_proc.terminate()
        try:
            server_proc.wait(20)
        except Exception:
            server_proc.kill()
    try:
        api("/api/runtime/stopped", {"reason": reason}, retries=2)
    except Exception as err:
        log(f"failed to report stop: {err}", "warn")


def watchdog():
    while not stop_event.is_set():
        if server_proc and server_proc.poll() is not None:
            log(f"llama-server exited unexpectedly (code {server_proc.returncode})", "error")
            try:
                api("/api/runtime/error", {"error": "llama-server exited unexpectedly"}, retries=1)
            except Exception:
                pass
            stop_event.set()
            return
        stop_event.wait(5)


def main():
    global runtime_token
    if not WORKER or not RUNTIME_KEY:
        raise RuntimeError("CONFIG.workerUrl and CONFIG.runtimeKey are required")
    log("VEXA runtime booting")
    reg = _http(WORKER + "/api/runtime/register", {
        "kernelRef": CONFIG.get("kernelSlug"),
        "kernelVersion": CONFIG.get("kernelVersion"),
        "nonce": CONFIG.get("sessionNonce"),
        "gpus": gpu_stats(),
        "host": socket.gethostname(),
    }, {"x-runtime-key": RUNTIME_KEY}, 30)
    runtime_token = reg.get("runtimeToken")
    if not runtime_token:
        raise RuntimeError("registration did not return a runtime token")
    if reg.get("stop"):
        log("control plane rejected this session (stop)", "warn")
        return
    for key in ("ctx", "parallel", "servedModel", "modelBytes", "modelSha256",
                "verifyFull", "dataset", "modelFile"):
        if reg.get(key) is not None:
            CONFIG[key] = reg[key]
    threading.Thread(target=log_sender, daemon=True).start()
    threading.Thread(target=heartbeat_loop, daemon=True).start()
    set_phase("allocated", "GPU session allocated; locating the persistent model")
    model_path = find_input_file(CONFIG["modelFile"])
    if not model_path:
        raise RuntimeError(f"{CONFIG['modelFile']} not found under /kaggle/input")
    log(f"model found at {model_path}")
    model_info = verify_model(model_path)
    server_path = prepare_llama(os.path.dirname(model_path))
    set_phase("loading", "starting llama.cpp with CUDA layer split across both T4s", 0.05)
    proc = start_server(server_path, model_path)
    threading.Thread(target=monitor_loading, args=(proc, model_info["bytes"]), daemon=True).start()
    wait_health(int(CONFIG.get("loadTimeoutSeconds") or 1200))
    set_phase("loading", "llama-server healthy; proving the model answers", 0.97)
    proof = selftest()
    log(f"self-test ok in {proof['ttftMs']}ms ({proof['tokPerSec']} tok/s): {proof['content']!r}")
    ready_event.set()
    gpus = gpu_stats()
    vram = sum((g.get("usedMiB") or 0) for g in gpus)
    set_phase("ready", "model loaded and verified; API is live", 1.0, {
        "model": {
            "id": CONFIG.get("servedModel"),
            "ctx": int(CONFIG.get("ctx") or 32768),
            "parallel": int(CONFIG.get("parallel") or 2),
            "gpuLayers": server_state.get("gpuLayers"),
            "totalLayers": server_state.get("totalLayers"),
            "vramMiB": vram,
            "bytes": model_info["bytes"],
            "sha256": model_info["sha256"],
            "models": server_models(),
        },
        "metrics": proof,
        "gpus": gpus,
    })
    threading.Thread(target=watchdog, daemon=True).start()
    for slot in range(int(CONFIG.get("parallel") or 2)):
        threading.Thread(target=poll_loop, args=(slot,), daemon=True).start()
    while not stop_event.is_set():
        stop_event.wait(1)
    shutdown("control plane requested shutdown")


def _signal(_signum, _frame):
    stop_event.set()


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, _signal)
    signal.signal(signal.SIGINT, _signal)
    try:
        main()
    except Exception as exc:
        log(f"fatal: {exc}", "error")
        log(traceback.format_exc(), "error")
        try:
            api("/api/runtime/error", {"error": str(exc)[:800], "trace": traceback.format_exc()[:4000]}, retries=1)
        except Exception:
            pass
        sys.exit(1)
