#!/usr/bin/env bash
# VEXA emulator session script — runs inside reactivecircus/android-emulator-runner
# after the AVD has booted. Starts the ADB bridge, cloudflared tunnel, publishes
# the gateway URL, keeps the device alive, then saves a whole-AVD checkpoint
# before shutdown (VIBELY persistence architecture).
set -uo pipefail

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

# Start VEXA ADB Bridge AFTER emulator is ready
PORT=8080 node android-emulator/vexa-bridge.mjs > /tmp/gateway.log 2>&1 &
BRIDGE_PID=$!
echo "VEXA ADB Bridge PID: $BRIDGE_PID"
sleep 3

# Start cloudflared tunnel
cloudflared tunnel --url http://localhost:8080 --no-autoupdate > /tmp/cloudflared.log 2>&1 &
TUNNEL_PID=$!
echo "Cloudflare tunnel PID: $TUNNEL_PID"

# Wait for tunnel URL
GATEWAY_URL=""
for i in $(seq 1 30); do
  GATEWAY_URL=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' /tmp/cloudflared.log 2>/dev/null | head -n1 || true)
  if [ -n "$GATEWAY_URL" ]; then
    echo "Live Gateway URL: $GATEWAY_URL"
    break
  fi
  sleep 2
done

# Publish gateway URL to data/emulator.json
if [ -n "$GATEWAY_URL" ]; then
  python3 - "$GATEWAY_URL" << 'PYEOF'
import json, datetime, os, sys
gateway_url = sys.argv[1]
p = "data/emulator.json"
with open(p) as f:
    d = json.load(f)
d["gatewayUrl"] = gateway_url
d["status"] = "online"
d["lastHeartbeat"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
d["activeRunId"] = os.environ.get("GITHUB_RUN_ID")
d["updatedAt"] = d["lastHeartbeat"]
with open(p, "w") as f:
    json.dump(d, f, indent=2)
    f.write("\n")
PYEOF
  git config user.name "VEXA Emulator"
  git config user.email "emulator@vexa.ai"
  git add data/emulator.json
  git commit -m "emulator: publish live gateway URL [skip ci]" || true
  git pull --rebase origin vexa || true
  git push origin vexa || true
fi

# Keep emulator alive for the rotation period
ROTATION_MINUTES="${ROTATION_MINUTES:-240}"
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
kill $TUNNEL_PID 2>/dev/null || true
adb emu kill 2>/dev/null || true
echo "Emulator session ended."
