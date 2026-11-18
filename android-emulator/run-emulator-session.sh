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
#   - Emulator → captures screenshot via ADB → POST /api/emulator/screenshot → stored in D1
#   - Agent runner → GET /api/public/screenshot → reads latest screenshot from D1
set -uo pipefail

CLOUDFLARE_WORKER_URL="https://vexa-ai-agent.replyraven001.workers.dev"
EMULATOR_ACCESS_TOKEN="${EMULATOR_ACCESS_TOKEN:-}"

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

# Start VEXA ADB Bridge AFTER emulator is ready (for local device control)
PORT=8080 node android-emulator/vexa-bridge.mjs > /tmp/gateway.log 2>&1 &
BRIDGE_PID=$!
echo "VEXA ADB Bridge PID: $BRIDGE_PID"
sleep 3

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

# --- SCREENSHOT UPLOAD LOOP ---
# Captures screenshots via ADB and uploads to Cloudflare Worker so the AI agent
# can see the live device screen through GET /api/public/screenshot
SCREENSHOT_PID=""
(
  while true; do
    # Capture screenshot via ADB
    SCREENSHOT_DATA=$(adb exec-out screencap -p 2>/dev/null | base64 -w 0 2>/dev/null || echo "")
    if [ -n "$SCREENSHOT_DATA" ] && [ "$SCREENSHOT_DATA" != "" ]; then
      # Compute a simple checksum
      CHECKSUM=$(echo -n "$SCREENSHOT_DATA" | md5sum | cut -d' ' -f1)
      curl -s -X POST "${CLOUDFLARE_WORKER_URL}/api/emulator/screenshot" \
        -H "Content-Type: application/json" \
        -d "{
          \"screenshotBase64\": \"${SCREENSHOT_DATA}\",
          \"checksum\": \"${CHECKSUM}\"
        }" > /dev/null 2>&1 || true
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
import json, sys, subprocess, urllib.request, urllib.error

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

try:
    if act_type == "tap":
        x = params["x"] or 540
        y = params["y"] or 1200
        subprocess.run(["adb", "shell", "input", "tap", str(x), str(y)], check=True, timeout=15000)
        success = True
    elif act_type == "swipe":
        x = params["x"] or 540
        y = params["y"] or 1500
        x2 = params["x2"] or 540
        y2 = params["y2"] or 500
        ms = params["ms"] or 300
        subprocess.run(["adb", "shell", "input", "swipe", str(x), str(y), str(x2), str(y2), str(ms)], check=True, timeout=15000)
        success = True
    elif act_type == "scroll":
        x = params["x"] or 540
        y1 = params["y"] or 1700
        y2 = params["y2"] or 700
        subprocess.run(["adb", "shell", "input", "swipe", str(x), str(y1), str(x), str(y2), "300"], check=True, timeout=15000)
        success = True
    elif act_type == "type":
        text = (params["text"] or "").replace(" ", "%s")
        subprocess.run(["adb", "shell", "input", "text", text], check=True, timeout=15000)
        success = True
    elif act_type == "key":
        keycode = params["keycode"] or 66
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
    elif act_type == "wait":
        ms = params["ms"] or 2000
        import time
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
        import time
        time.sleep(1.5)

    # Capture screenshot after action
    result = subprocess.run(["adb", "exec-out", "screencap", "-p"], capture_output=True, timeout=20000)
    if result.returncode == 0:
        import base64, hashlib
        screenshot_b64 = base64.b64encode(result.stdout).decode("ascii")
        checksum = hashlib.md5(result.stdout).hexdigest()
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