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
adb wait-for-device
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
    # `adb exec-out screencap -p > file` streams a full frame in under a second.
    # We must redirect to a file: capturing binary in $(...) lets bash drop NUL
    # bytes and corrupts the PNG. mobilerun's `screencap -p <file>` path is not
    # used because on a software-rendered emulator it takes 60-90s and can hang.
    if timeout 20 adb exec-out screencap -p > /tmp/vexa_screen.png 2>/dev/null; then
      SIZE=$(wc -c < /tmp/vexa_screen.png 2>/dev/null || echo 0)
      # A real frame is a PNG of tens of KB; a 1x1 blank is ~67 bytes.
      if [ "$SIZE" -gt 2000 ] && head -c 4 /tmp/vexa_screen.png | od -An -tx1 | grep -q "89 50 4e 47"; then
        SCREENSHOT_DATA=$(base64 -w 0 /tmp/vexa_screen.png 2>/dev/null || echo "")
        SCREENSHOT_SIZE=$SIZE
      fi
    fi

    # --- UI hierarchy capture via uiautomator dump ---
    adb shell uiautomator dump /sdcard/vexa_ui.xml 2>/dev/null || true
    sleep 0.2
    adb pull /sdcard/vexa_ui.xml /tmp/vexa_ui.xml 2>/dev/null || true
    if [ -f /tmp/vexa_ui.xml ]; then
      UI_SIZE=$(wc -c < /tmp/vexa_ui.xml 2>/dev/null || echo "0")
      if [ "$UI_SIZE" -gt 100 ]; then
        UI_HIERARCHY=$(base64 -w 0 /tmp/vexa_ui.xml 2>/dev/null || echo "")
      fi
    fi
    # Fallback: dumpsys window windows
    if [ -z "$UI_HIERARCHY" ]; then
      DUMPSYS_DATA=$(adb shell dumpsys window windows 2>/dev/null | head -100 || echo "")
      if [ -n "$DUMPSYS_DATA" ] && [ $(echo -n "$DUMPSYS_DATA" | wc -c) -gt 100 ]; then
        UI_HIERARCHY=$(echo -n "DUMPSYS_WINDOWS:$DUMPSYS_DATA" | base64 -w 0 2>/dev/null || echo "")
      fi
    fi

    # Upload screenshot + UI hierarchy to Cloudflare Worker
    if [ -n "$SCREENSHOT_DATA" ] || [ -n "$UI_HIERARCHY" ]; then
      CHECKSUM=$(echo -n "$SCREENSHOT_DATA" | md5sum | cut -d' ' -f1)
      curl -s -X POST "${CLOUDFLARE_WORKER_URL}/api/emulator/screenshot" \
        -H "Content-Type: application/json" \
        -d "{
          \"screenshotBase64\": \"${SCREENSHOT_DATA}\",
          \"checksum\": \"${CHECKSUM}\",
          \"uiHierarchy\": \"${UI_HIERARCHY}\"
        }" > /dev/null 2>&1 || true
      if [ -n "$SCREENSHOT_DATA" ]; then
        echo "Screenshot uploaded (${SCREENSHOT_SIZE} bytes)"
      fi
      if [ -n "$UI_HIERARCHY" ]; then
        echo "UI hierarchy uploaded (${UI_SIZE} bytes)"
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
      # Extract action fields using python for reliable JSON parsing
      python3 - "$CLOUDFLARE_WORKER_URL" << 'PYEOF'
import json, sys, subprocess, urllib.request, urllib.error, base64, hashlib, time, os

worker_url = sys.argv[1]

# Fetch the pending action
try:
    req = urllib.request.Request(f"{worker_url}/api/emulator/pending-action")
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read().decode())
except Exception as e:
    print(f"Failed to fetch pending action: {e}")
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
        subprocess.run(["adb", "shell", "input", "tap", str(x), str(y)], check=True, timeout=15000)
        success = True
    elif act_type == "swipe":
        x = int(params["x"] or 540)
        y = int(params["y"] or 1500)
        x2 = int(params["x2"] or 540)
        y2 = int(params["y2"] or 500)
        ms = int(params["ms"] or 300)
        subprocess.run(["adb", "shell", "input", "swipe", str(x), str(y), str(x2), str(y2), str(ms)], check=True, timeout=15000)
        success = True
    elif act_type == "scroll":
        x = int(params["x"] or 540)
        y1 = int(params["y"] or 1700)
        y2 = int(params["y2"] or 700)
        subprocess.run(["adb", "shell", "input", "swipe", str(x), str(y1), str(x), str(y2), "300"], check=True, timeout=15000)
        success = True
    elif act_type == "type":
        text = (params["text"] or "").replace(" ", "%s")
        subprocess.run(["adb", "shell", "input", "text", text], check=True, timeout=15000)
        success = True
    elif act_type == "key":
        keycode = int(params["keycode"] or 66)
        subprocess.run(["adb", "shell", "input", "keyevent", str(keycode)], check=True, timeout=15000)
        success = True
    elif act_type == "back":
        subprocess.run(["adb", "shell", "input", "keyevent", "4"], check=True, timeout=15000)
        success = True
    elif act_type == "home":
        subprocess.run(["adb", "shell", "input", "keyevent", "3"], check=True, timeout=15000)
        success = True
    elif act_type == "recents":
        subprocess.run(["adb", "shell", "input", "keyevent", "187"], check=True, timeout=15000)
        success = True
    elif act_type == "launch":
        app = params["app"] or params["text"]
        if app:
            subprocess.run(["adb", "shell", "monkey", "-p", str(app), "-c", "android.intent.category.LAUNCHER", "1"], check=True, timeout=15000)
            success = True
        else:
            error = "No app specified for launch"
    elif act_type == "recents":
        subprocess.run(["adb", "shell", "input", "keyevent", "187"], check=True, timeout=15000)
        success = True
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
            subprocess.run(["adb", "shell", shell_cmd], check=True, timeout=15000)
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
        subprocess.run(["adb", "shell", "uiautomator", "dump", "/sdcard/vexa_ui.xml"], capture_output=True, timeout=10000)
        time.sleep(0.2)
        if os.path.exists("/tmp/vexa_ui.xml"):
            os.remove("/tmp/vexa_ui.xml")
        ui_result = subprocess.run(["adb", "pull", "/sdcard/vexa_ui.xml", "/tmp/vexa_ui.xml"], capture_output=True, timeout=10000)
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

# Report result back to Cloudflare Worker
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

    req = urllib.request.Request(
        f"{worker_url}/api/emulator/action-result",
        data=json.dumps(result_data).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        print(f"Action result reported: {resp.status}")
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
