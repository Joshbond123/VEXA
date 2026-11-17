#!/usr/bin/env bash
# VEXA emulator session script — runs inside reactivecircus/android-emulator-runner
# after the AVD has booted. Registers with Cloudflare Worker gateway (permanent
# endpoint) instead of temporary Cloudflare Tunnel URLs.
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

# Start VEXA ADB Bridge AFTER emulator is ready
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
  # Also publish gateway URL to data/emulator.json for backward compatibility
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
# Unregister emulator
curl -s -X DELETE "${CLOUDFLARE_WORKER_URL}/api/emulator/session" > /dev/null 2>&1 || true
adb emu kill 2>/dev/null || true
echo "Emulator session ended."
