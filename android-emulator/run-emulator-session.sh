#!/usr/bin/env bash
# VEXA emulator session script — runs inside reactivecircus/android-emulator-runner
# after the AVD has booted. Registers with Cloudflare Worker gateway (permanent
# endpoint) instead of temporary Cloudflare Tunnel URLs.
#
# ARCHITECTURE: Cloudflare Worker acts as the bridge between the AI agent runner
# (separate GitHub Actions workflow) and this Android emulator:
#   - Agent runner → POST /api/emulator/action → stored in Cloudflare D1
#   - Emulator → GET /api/emulator/pending-action → picks up action
#   - Emulator → executes action via ADB → POST /api/emulator/action-result
#   - Emulator → captures screenshot via `adb exec-out screencap -p` → POST /api/emulator/screenshot → stored in D1
#   - Emulator → captures UI hierarchy via uiautomator dump → stored in D1
#   - Agent runner → GET /api/public/screenshot → reads latest screenshot from D1
#   - Agent runner → GET /api/public/device-state → reads UI hierarchy from D1
#
# HEADLESS SCREENSHOT METHOD:
#   `adb exec-out screencap -p` redirected straight to a file streams a complete
#   PNG in under a second and is the primary capture path. The older screenrecord
#   + ffmpeg frame extraction was removed: it produced 1x1 frames and raced with
#   the encoder. mobilerun's `screencap -p <file>` path is avoided too — on a
#   software-rendered emulator it takes 60-90s and can hang indefinitely.
set -uo pipefail

CLOUDFLARE_WORKER_URL="https://vexa-ai-agent.replyraven001.workers.dev"
EMULATOR_ACCESS_TOKEN="${EMULATOR_ACCESS_TOKEN:-}"

echo "=== VEXA Emulator Session Starting ==="
echo "Cloudflare Worker: $CLOUDFLARE_WORKER_URL"

echo "Waiting for Android emulator to be online..."
# Bounded wait: `adb wait-for-device` blocks forever if the emulator never came
# up, which is what made this step hang until the job timeout with no log.
DEVICE_READY=false
for i in $(seq 1 60); do
  if adb devices 2>/dev/null | grep -q "device$"; then DEVICE_READY=true; break; fi
  sleep 5
done
if [ "$DEVICE_READY" != "true" ]; then
  echo "ERROR: no adb device after 5 minutes; emulator failed to boot"
  adb devices || true
  exit 1
fi
adb shell settings put global adb_enabled 1

echo "Waiting for boot completion..."
for i in $(seq 1 60); do
  BOOT=$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || echo "0")
  if [ "$BOOT" = "1" ]; then
    echo "Android boot completed!"
    break
  fi
  sleep 5
done

# Detect device info
DEVICE_MODEL=$(adb shell getprop ro.product.model 2>/dev/null | tr -d '\r' || echo "Pixel 7")
ANDROID_VERSION=$(adb shell getprop ro.build.version.release 2>/dev/null | tr -d '\r' || echo "14")
RESOLUTION=$(adb shell wm size 2>/dev/null | grep -oP '\d+x\d+' || echo "1080x2400")

echo "Device: $DEVICE_MODEL Android $ANDROID_VERSION $RESOLUTION"

# Start the mobilerun device bridge (HTTP on 127.0.0.1:8765). This is what the
# agent runner talks to for screenshots, UI trees, and taps — it must be up
# before the agent starts, otherwise the agent is blind and falls back to the
# Cloudflare relay. Port is fixed so MOBILERUN_BRIDGE=http://127.0.0.1:8765.
echo "Starting mobilerun device bridge..."
MOBILERUN_SERIAL="$(adb devices | awk '/\tdevice$/{print $1; exit}')" \
MOBILERUN_PORT=8765 \
nohup python3 vexa-api/android/mobilerun_bridge.py > /tmp/mobilerun-bridge.log 2>&1 &
BRIDGE_PID=$!
echo "mobilerun bridge PID: $BRIDGE_PID (serial=${MOBILERUN_SERIAL:-auto})"
for i in $(seq 1 20); do
  if curl -sf --max-time 5 http://127.0.0.1:8765/health > /tmp/bridge-health.json 2>/dev/null; then
    echo "mobilerun bridge is up: $(cat /tmp/bridge-health.json)"
    break
  fi
  sleep 2
done

# Register emulator with Cloudflare Worker gateway (permanent endpoint)
echo "Registering emulator with Cloudflare Worker gateway..."
REGISTER_SUCCESS=false
for i in $(seq 1 30); do
  REGISTER_RESPONSE=$(curl -s -X POST "${CLOUDFLARE_WORKER_URL}/api/emulator/register" \
    -H "Content-Type: application/json" \
    -d "{
      \"gatewayUrl\": \"${CLOUDFLARE_WORKER_URL}\",
      \"deviceModel\": \"${DEVICE_MODEL}\",
      \"androidVersion\": \"${ANDROID_VERSION}\",
      \"resolution\": \"${RESOLUTION}\",
      \"activeRunId\": \"${GITHUB_RUN_ID}\",
      \"accessToken\": \"${EMULATOR_ACCESS_TOKEN}\"
    }" 2>/dev/null || echo "{}")

  REGISTER_SUCCESS=$(echo "$REGISTER_RESPONSE" | grep -o '"ok":true' || echo "false")
  if [ "$REGISTER_SUCCESS" = "false" ]; then
    echo "Registration attempt $i failed, retrying in 5s..."
    sleep 5
  else
    echo "Emulator registered successfully with Cloudflare Worker gateway"
    break
  fi
done

if [ "$REGISTER_SUCCESS" != "false" ]; then
  # Publish gateway URL to data/emulator.json for backward compatibility
  python3 - "$CLOUDFLARE_WORKER_URL" << 'PYEOF'
import json, datetime, os, sys
gateway_url = sys.argv[1]
p = "data/emulator.json"
try:
    with open(p) as f:
        d = json.load(f)
except:
    d = {}
d["gatewayUrl"] = gateway_url
d["status"] = "online"
d["lastHeartbeat"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
d["deviceModel"] = os.environ.get("DEVICE_MODEL", "Pixel 7")
d["androidVersion"] = os.environ.get("ANDROID_VERSION", "14")
d["resolution"] = os.environ.get("RESOLUTION", "1080x2400")
d["loggedInAccount"] = "preserved-session"
d["activeRunId"] = os.environ.get("GITHUB_RUN_ID")
d["updatedAt"] = d["lastHeartbeat"]
with open(p, "w") as f:
    json.dump(d, f, indent=2)
    f.write("\n")
PYEOF

  git config user.name "VEXA Emulator"
  git config user.email "emulator@vexa.ai"
  git add data/emulator.json
  git commit -m "emulator: register with Cloudflare Worker gateway [skip ci]" || true
  git pull --rebase origin vexa || true
  git push origin vexa || true
fi

# Heartbeat loop — keep emulator registered with Cloudflare gateway
echo "Starting heartbeat loop to Cloudflare Worker gateway..."
HEARTBEAT_PID=""
(
  while true; do
    curl -s -X POST "${CLOUDFLARE_WORKER_URL}/api/emulator/heartbeat" \
      -H "Content-Type: application/json" \
      -d "{
        \"status\": \"online\",
        \"deviceModel\": \"${DEVICE_MODEL}\",
        \"androidVersion\": \"${ANDROID_VERSION}\",
        \"resolution\": \"${RESOLUTION}\",
        \"activeRunId\": \"${GITHUB_RUN_ID}\"
      }" > /dev/null 2>&1 || true
    sleep 30
  done
) &
HEARTBEAT_PID=$!
echo "Heartbeat PID: $HEARTBEAT_PID"

# --- SCREENSHOT & UI HIERARCHY UPLOAD LOOP ---
# Captures screenshots via `adb exec-out screencap -p` and UI hierarchy via
# uiautomator dump. Uploads both to the Cloudflare Worker.
SCREENSHOT_PID=""
(
  while true; do
    SCREENSHOT_DATA=""
    SCREENSHOT_SIZE=0
    UI_HIERARCHY=""

    # --- Screenshot capture ---
    # `adb exec-out screencap -p > file` streams a full frame. On a
    # software-rendered emulator the first frames can take well over 20s, so
    # allow 45s and fall back to capturing to a device file and pulling it.
    if timeout 45 adb exec-out screencap -p > /tmp/vexa_screen.png 2>/dev/null; then
      :
    else
      timeout 45 adb shell screencap -p /sdcard/vexa_screen.png >/dev/null 2>&1 || true
      adb pull /sdcard/vexa_screen.png /tmp/vexa_screen.png >/dev/null 2>&1 || true
    fi
    SIZE=$(wc -c < /tmp/vexa_screen.png 2>/dev/null || echo 0)
    # A real frame is a PNG of tens of KB; a 1x1 blank is ~67 bytes.
    if [ "$SIZE" -gt 2000 ] && head -c 4 /tmp/vexa_screen.png | od -An -tx1 | grep -q "89 50 4e 47"; then
      base64 -w 0 /tmp/vexa_screen.png > /tmp/vexa_screen.b64 2>/dev/null || : > /tmp/vexa_screen.b64
      SCREENSHOT_SIZE=$SIZE
    else
      : > /tmp/vexa_screen.b64
    fi

    # --- UI hierarchy capture via uiautomator dump ---
    : > /tmp/vexa_ui.b64
    adb shell uiautomator dump /sdcard/vexa_ui.xml 2>/dev/null || true
    sleep 0.2
    adb pull /sdcard/vexa_ui.xml /tmp/vexa_ui.xml 2>/dev/null || true
    if [ -f /tmp/vexa_ui.xml ]; then
      UI_SIZE=$(wc -c < /tmp/vexa_ui.xml 2>/dev/null || echo "0")
      if [ "$UI_SIZE" -gt 100 ]; then
        base64 -w 0 /tmp/vexa_ui.xml > /tmp/vexa_ui.b64 2>/dev/null || true
      fi
    fi
    # Fallback: dumpsys window windows
    if [ ! -s /tmp/vexa_ui.b64 ]; then
      adb shell dumpsys window windows 2>/dev/null | head -100 > /tmp/vexa_dumpsys.txt || true
      if [ "$(wc -c < /tmp/vexa_dumpsys.txt 2>/dev/null || echo 0)" -gt 100 ]; then
        { echo -n "DUMPSYS_WINDOWS:"; cat /tmp/vexa_dumpsys.txt; } | base64 -w 0 > /tmp/vexa_ui.b64 2>/dev/null || true
      fi
    fi

    # Upload screenshot + UI hierarchy to Cloudflare Worker.
    # The base64 payload is far too large for a shell argument (ARG_MAX), so
    # assemble the JSON body with files and stream it with --data-binary @file.
    if [ -s /tmp/vexa_screen.b64 ] || [ -s /tmp/vexa_ui.b64 ]; then
      CHECKSUM=$(md5sum /tmp/vexa_screen.b64 | cut -d' ' -f1)
      # Downscaled JPEG variant: a full 1080x1920 PNG is several megabytes, which
      # a client on a weak mobile link cannot download fast enough to look live.
      # ffmpeg produces a ~40-80KB JPEG that the same client can poll smoothly.
      : > /tmp/vexa_small.b64
      if [ -s /tmp/vexa_screen.png ] && command -v ffmpeg >/dev/null 2>&1; then
        ffmpeg -y -loglevel error -i /tmp/vexa_screen.png \
          -vf "scale=-2:540" -q:v 6 /tmp/vexa_small.jpg 2>/dev/null || true
        if [ -s /tmp/vexa_small.jpg ]; then
          base64 -w 0 /tmp/vexa_small.jpg > /tmp/vexa_small.b64 2>/dev/null || : > /tmp/vexa_small.b64
        fi
      fi
      python3 - /tmp/vexa_screen.b64 /tmp/vexa_ui.b64 "$CHECKSUM" /tmp/vexa_small.b64 > /tmp/vexa_upload.json << 'PYJSON'
import json, sys
screenshot = open(sys.argv[1]).read().strip()
ui = open(sys.argv[2]).read().strip()
body = {"screenshotBase64": screenshot, "checksum": sys.argv[3], "uiHierarchy": ui}
try:
    small = open(sys.argv[4]).read().strip()
except Exception:
    small = ""
if small:
    body["smallScreenshotBase64"] = small
json.dump(body, sys.stdout)
PYJSON
      CODE=$(curl -s -m 90 -o /dev/null -w "%{http_code}" -X POST "${CLOUDFLARE_WORKER_URL}/api/emulator/screenshot" \
        -H "Content-Type: application/json" \
        --data-binary @/tmp/vexa_upload.json 2>/dev/null || echo "000")
      if [ "$CODE" = "200" ]; then
        [ -s /tmp/vexa_screen.b64 ] && echo "Screenshot uploaded (${SCREENSHOT_SIZE} bytes)"
        [ -s /tmp/vexa_ui.b64 ] && echo "UI hierarchy uploaded"
      else
        echo "Screenshot upload failed (HTTP ${CODE})" >&2
      fi
    else
      echo "Screenshot+UI capture failed, will retry" >&2
    fi
    sleep 2
  done
) &
SCREENSHOT_PID=$!
echo "Screenshot upload PID: $SCREENSHOT_PID"

# --- ACTION POLLING AND EXECUTION LOOP ---
# Polls Cloudflare Worker for pending actions, executes via ADB, reports results
ACTION_PID=""
(
  while true; do
    # Poll for pending action
    ACTION_RESPONSE=$(curl -s -X GET "${CLOUDFLARE_WORKER_URL}/api/emulator/pending-action" 2>/dev/null || echo '{"ok":true,"action":null}')
    HAS_ACTION=$(echo "$ACTION_RESPONSE" | grep -o '"action":{' || echo "")

    if [ -n "$HAS_ACTION" ]; then
      # Hand the action to the executor through a file: `python3 - << HEREDOC`
      # already consumes stdin for the program, so the JSON cannot be piped in.
      printf '%s' "$ACTION_RESPONSE" > /tmp/vexa_action.json
      python3 - "$CLOUDFLARE_WORKER_URL" /tmp/vexa_action.json << 'PYEOF'
import json, sys, subprocess, base64, hashlib, time, os

worker_url = sys.argv[1]

try:
    with open(sys.argv[2]) as fh:
        data = json.load(fh)
except Exception as e:
    print(f"Failed to parse pending action: {e}")
    sys.exit(1)

action = data.get("action")
if not action:
    sys.exit(0)

act_type = action.get("action", "")
params = {
    "x": action.get("x"),
    "y": action.get("y"),
    "x2": action.get("x2"),
    "y2": action.get("y2"),
    "text": action.get("text"),
    "keycode": action.get("keycode"),
    "app": action.get("app"),
    "ms": action.get("ms"),
}

success = False
error = None
screenshot_b64 = None
checksum = None
ui_hierarchy_b64 = None

try:
    if act_type == "tap":
        x = int(params["x"] or 540)
        y = int(params["y"] or 1200)
        subprocess.run(["adb", "shell", "input", "tap", str(x), str(y)], check=True, timeout=30)
        success = True
    elif act_type == "swipe":
        x = int(params["x"] or 540)
        y = int(params["y"] or 1500)
        x2 = int(params["x2"] or 540)
        y2 = int(params["y2"] or 500)
        ms = int(params["ms"] or 300)
        subprocess.run(["adb", "shell", "input", "swipe", str(x), str(y), str(x2), str(y2), str(ms)], check=True, timeout=30)
        success = True
    elif act_type == "scroll":
        x = int(params["x"] or 540)
        y1 = int(params["y"] or 1700)
        y2 = int(params["y2"] or 700)
        subprocess.run(["adb", "shell", "input", "swipe", str(x), str(y1), str(x), str(y2), "300"], check=True, timeout=30)
        success = True
    elif act_type == "type":
        text = (params["text"] or "").replace(" ", "%s")
        subprocess.run(["adb", "shell", "input", "text", text], check=True, timeout=30)
        success = True
    elif act_type == "key":
        keycode = int(params["keycode"] or 66)
        subprocess.run(["adb", "shell", "input", "keyevent", str(keycode)], check=True, timeout=30)
        success = True
    elif act_type == "back":
        subprocess.run(["adb", "shell", "input", "keyevent", "4"], check=True, timeout=30)
        success = True
    elif act_type == "home":
        subprocess.run(["adb", "shell", "input", "keyevent", "3"], check=True, timeout=30)
        success = True
    elif act_type == "recents":
        subprocess.run(["adb", "shell", "input", "keyevent", "187"], check=True, timeout=30)
        success = True
    elif act_type == "launch":
        app = params["app"] or params["text"]
        if app:
            name = str(app).strip()
            # Accept a human name as well as a package: `monkey` exits 252 when
            # the package has no launcher entry or the name is wrong, which is
            # what made 'launch Calculator' fail on an image whose calculator
            # is com.android.calculator2, not com.google.android.calculator.
            aliases = {
                "calculator": "com.android.calculator2",
                "settings": "com.android.settings",
                "chrome": "com.android.chrome",
                "camera": "com.android.camera2",
                "phone": "com.android.dialer",
                "messages": "com.android.messaging",
                "play store": "com.android.vending",
                "browser": "com.android.browser",
            }
            pkg = aliases.get(name.lower(), name)

            launched = False
            # Resolve the package's launcher activity and start it explicitly.
            try:
                r = subprocess.run(
                    ["adb", "shell", "cmd", "package", "resolve-activity", "--brief",
                     "-c", "android.intent.category.LAUNCHER", pkg],
                    capture_output=True, timeout=30,
                )
                comp = r.stdout.decode("utf-8", "replace").strip().splitlines()[-1] if r.stdout.strip() else ""
                if r.returncode == 0 and "/" in comp:
                    subprocess.run(["adb", "shell", "am", "start", "-n", comp], check=True, timeout=30)
                    launched = True
            except Exception:
                pass
            if not launched:
                m = subprocess.run(
                    ["adb", "shell", "monkey", "-p", pkg,
                     "-c", "android.intent.category.LAUNCHER", "1"],
                    capture_output=True, timeout=30,
                )
                launched = m.returncode == 0
            if launched:
                success = True
            else:
                error = f"Could not launch '{name}' (package {pkg}); it may not be installed"
        else:
            error = "No app specified for launch"
    elif act_type == "screenshot":
        # No device interaction: the capture step below refreshes the frame.
        success = True
    elif act_type == "wait":
        ms = int(params["ms"] or 2000)
        time.sleep(min(10, ms / 1000.0))
        success = True
    elif act_type == "shell":
        shell_cmd = params["text"]
        if shell_cmd:
            subprocess.run(["adb", "shell", shell_cmd], check=True, timeout=30)
            success = True
        else:
            error = "No shell command specified"
    else:
        error = f"Unknown action: {act_type}"

    # Wait briefly for screen to settle after action
    if success and act_type in ("launch", "tap", "home", "back", "key"):
        time.sleep(1.5)

    # --- Capture screenshot + UI hierarchy after action ---
    def capture_screenshot_and_ui():
        import base64, hashlib, subprocess, os, time
        screenshot_b64 = None
        checksum = None
        ui_hierarchy_b64 = None

        # exec-out screencap -p redirected to a file: fast and uncorrupted.
        # (mobilerun's screencap-to-file path can take 60-90s and hang.)
        try:
            with open("/tmp/vexa_action.png", "wb") as fh:
                proc = subprocess.run(
                    ["adb", "exec-out", "screencap", "-p"],
                    stdout=fh, stderr=subprocess.DEVNULL, timeout=25,
                )
            if proc.returncode == 0 and os.path.getsize("/tmp/vexa_action.png") > 2000:
                with open("/tmp/vexa_action.png", "rb") as fh:
                    raw = fh.read()
                if raw[:4] == b"\x89PNG":
                    return base64.b64encode(raw).decode("ascii"), hashlib.md5(raw).hexdigest(), None
        except Exception:
            pass

        return None, None, None

    screenshot_b64, checksum, _ = capture_screenshot_and_ui()

    # UI hierarchy via uiautomator dump
    try:
        subprocess.run(["adb", "shell", "uiautomator", "dump", "/sdcard/vexa_ui.xml"], capture_output=True, timeout=30)
        time.sleep(0.2)
        if os.path.exists("/tmp/vexa_ui.xml"):
            os.remove("/tmp/vexa_ui.xml")
        ui_result = subprocess.run(["adb", "pull", "/sdcard/vexa_ui.xml", "/tmp/vexa_ui.xml"], capture_output=True, timeout=30)
        if ui_result.returncode == 0 and os.path.exists("/tmp/vexa_ui.xml"):
            with open("/tmp/vexa_ui.xml", "rb") as f:
                ui_data = f.read()
            if len(ui_data) > 100:
                ui_hierarchy_b64 = base64.b64encode(ui_data).decode("ascii")
    except Exception:
        pass
except subprocess.CalledProcessError as e:
    error = f"ADB command failed: {e}"
except Exception as e:
    error = f"Action execution error: {e}"
    success = False

# Report result back to Cloudflare Worker. Use curl, not urllib: Cloudflare's
# bot protection stalls a request whose User-Agent is Python-urllib, so the
# result never landed and the queued action stayed 'pending' forever.
try:
    result_data = {
        "action": act_type,
        "success": success,
    }
    if error:
        result_data["error"] = error
    if screenshot_b64:
        result_data["screenshotBase64"] = screenshot_b64
    if checksum:
        result_data["checksum"] = checksum
    if ui_hierarchy_b64:
        result_data["uiHierarchy"] = ui_hierarchy_b64

    proc = subprocess.run(
        ["curl", "-s", "-m", "30", "-o", "/dev/null", "-w", "%{http_code}",
         "-X", "POST", f"{worker_url}/api/emulator/action-result",
         "-H", "Content-Type: application/json",
         "--data-binary", "@-"],
        input=json.dumps(result_data).encode("utf-8"),
        capture_output=True,
        timeout=40,
    )
    print(f"Action result reported: HTTP {proc.stdout.decode('ascii', 'replace').strip()}")
except Exception as e:
    print(f"Failed to report action result: {e}")
PYEOF
    fi

    sleep 2
  done
) &
ACTION_PID=$!
echo "Action polling PID: $ACTION_PID"

# Keep emulator alive for the rotation period
ROTATION_MINUTES="${ROTATION_MINUTES:-360}"
echo "Emulator running. Keeping alive for ${ROTATION_MINUTES} minutes..."
sleep $(( ROTATION_MINUTES * 60 ))

# --- Save whole-AVD checkpoint before shutdown (persistence) ---
if [ "${EMULATOR_STATE_KEY:-}" != "" ] && [ "${GH_PAT:-}" != "" ]; then
  echo "[save-checkpoint] Capturing whole-AVD checkpoint before shutdown..."
  export PYTHONPATH="$PWD/android-emulator${PYTHONPATH:+:$PYTHONPATH}"
  export ANDROID_AVD_HOME="$HOME/.android/avd"
  export CHECKPOINT_HOLD=true
  bash "$PWD/android-emulator/save-whole-avd.sh" || echo "[save-checkpoint] WARNING: checkpoint save failed (non-fatal)"
else
  echo "[save-checkpoint] Skipping: EMULATOR_STATE_KEY or GH_PAT not configured"
fi

# Clean shutdown
kill $BRIDGE_PID 2>/dev/null || true
kill $HEARTBEAT_PID 2>/dev/null || true
kill $SCREENSHOT_PID 2>/dev/null || true
kill $ACTION_PID 2>/dev/null || true
# Unregister emulator
curl -s -X DELETE "${CLOUDFLARE_WORKER_URL}/api/emulator/session" > /dev/null 2>&1 || true
adb emu kill 2>/dev/null || true
echo "Emulator session ended."
