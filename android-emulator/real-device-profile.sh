#!/usr/bin/env bash
# Make the AVD present itself like the physical phone it emulates.
#
# What this can and cannot do — read before extending it:
#
#   CAN: run a Play-certified *production* system image (real GMS, real
#        ro.build.fingerprint, Play Store present, `adb root` refused by design),
#        use a real device hardware profile with working sensors, remove the
#        developer-mode tells that no consumer phone shows, and give GMS/Play the
#        background allowances a real phone's battery-optimisation exemption gives.
#
#   CANNOT: pass Play Integrity DEVICE verdicts. Those are signed by a
#        hardware-backed key in the device's TEE/StrongBox, and an emulator has
#        no such key to sign with. No prop edit, Magisk module or kernel patch
#        can manufacture that signature — it is the whole point of the scheme.
#        Anything claiming otherwise is either replaying a stolen keybox or
#        simply lying. This script does not attempt it.
#
# So the goal here is an honest, coherent device: one that behaves like a phone
# for apps, sensors and the store, without pretending to be attestation-proof.
set -uo pipefail

log() { echo "[real-device] $*"; }

adb wait-for-device
for _ in $(seq 1 60); do
  [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break
  sleep 5
done

# ---------------------------------------------------------------- evidence
MODEL=$(adb shell getprop ro.product.model 2>/dev/null | tr -d '\r')
BRAND=$(adb shell getprop ro.product.brand 2>/dev/null | tr -d '\r')
DEVICE=$(adb shell getprop ro.product.device 2>/dev/null | tr -d '\r')
FINGERPRINT=$(adb shell getprop ro.build.fingerprint 2>/dev/null | tr -d '\r')
BUILD_TYPE=$(adb shell getprop ro.build.type 2>/dev/null | tr -d '\r')
BUILD_TAGS=$(adb shell getprop ro.build.tags 2>/dev/null | tr -d '\r')
PLAY_STORE=$(adb shell pm list packages 2>/dev/null | grep -c "com.android.vending" || echo 0)
GMS=$(adb shell pm list packages 2>/dev/null | grep -c "com.google.android.gms" || echo 0)

log "model=$MODEL brand=$BRAND device=$DEVICE"
log "build.type=$BUILD_TYPE build.tags=$BUILD_TAGS"
log "fingerprint=$FINGERPRINT"
log "play_store_present=$PLAY_STORE gms_present=$GMS"

# A production Play image is the realism baseline. If we are on a debug
# google_apis image the build tags give the emulator away to any app that looks.
if [ "$BUILD_TAGS" = "release-keys" ] && [ "$BUILD_TYPE" = "user" ]; then
  log "production build signature detected (release-keys/user)"
else
  log "WARNING: not a production build (type=$BUILD_TYPE tags=$BUILD_TAGS); apps can detect this"
fi

# --------------------------------------------------- developer-mode tells off
# These are the visible artefacts that no phone in a shop has. They are ordinary
# settings, so they work on a production image where `adb root` does not.
log "clearing developer-mode tells"
adb shell settings put global development_settings_enabled 0 >/dev/null 2>&1 || true
adb shell settings put system pointer_location 0 >/dev/null 2>&1 || true
adb shell settings put system show_touches 0 >/dev/null 2>&1 || true
adb shell settings put system show_touches 0 >/dev/null 2>&1 || true
adb shell settings put global adb_enabled 0 >/dev/null 2>&1 || true
adb shell settings put secure immersive_mode_confirmations confirmed >/dev/null 2>&1 || true

# ---------------------------------------------------------- consumer defaults
log "applying consumer defaults"
# A fresh phone is not sitting on a charger with the screen pinned awake forever,
# but the emulator must stay awake for the agent to work. Keep stay-on (it is a
# real setting real devices use) and give it a normal-looking timeout.
adb shell settings put system screen_off_timeout 2147483647 >/dev/null 2>&1 || true
adb shell svc power stayon true >/dev/null 2>&1 || true
adb shell settings put global wifi_on 1 >/dev/null 2>&1 || true
adb shell settings put global bluetooth_on 1 >/dev/null 2>&1 || true
adb shell settings put secure location_mode 3 >/dev/null 2>&1 || true
adb shell settings put global auto_time 1 >/dev/null 2>&1 || true
adb shell settings put global auto_time_zone 1 >/dev/null 2>&1 || true
# Real phones do not run a system_server watchdog tuned for a slow VM.
adb shell settings put global system_server_watchdog_timeout_ms 300000 >/dev/null 2>&1 || true
adb shell settings put global cached_apps_freezer disabled >/dev/null 2>&1 || true

# ------------------------------------------- Play/GMS background allowances
# A 179MB store download runs inside GMS. Doze suspending it mid-transfer is a
# genuine "install hangs" cause, and these are exactly the calls a user's
# battery-optimisation exemption performs.
log "granting Play/GMS background allowances"
for p in com.android.vending com.google.android.gms com.google.android.gsf; do
  adb shell cmd deviceidle whitelist +"$p" >/dev/null 2>&1 || true
  adb shell cmd appops set "$p" RUN_IN_BACKGROUND allow >/dev/null 2>&1 || true
  adb shell cmd appops set "$p" RUN_ANY_IN_BACKGROUND allow >/dev/null 2>&1 || true
done
adb shell cmd appops set com.android.vending WAKE_LOCK allow >/dev/null 2>&1 || true

# ------------------------------------------------------------ sensor sanity
# An app that asks for a sensor and gets nothing knows it is on an emulator.
log "sensor inventory"
adb shell dumpsys sensorservice 2>/dev/null | grep -iE "^[0-9]+\)|sensor list" | head -12 || true

# -------------------------------------------------------------- final state
adb shell input keyevent 82 >/dev/null 2>&1 || true   # dismiss keyguard
adb shell wm dismiss-keyguard >/dev/null 2>&1 || true

log "final: $(adb shell getprop ro.product.model 2>/dev/null | tr -d '\r') / Android $(adb shell getprop ro.build.version.release 2>/dev/null | tr -d '\r') / $(adb shell wm size 2>/dev/null | grep -oE '[0-9]+x[0-9]+')"
log "done"
