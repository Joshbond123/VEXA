#!/usr/bin/env bash
# Boot the VEXA Android emulator, preferring a Google Play capable image.
#
# Why this script exists: the Play Store only ships inside Google's
# `google_apis_playstore` system images. You cannot side-load it onto a
# `google_apis` image — the store depends on GMS services that are only present
# in the Play build, and a Play image is a production build where `adb root`
# fails by design. So the image choice *is* the Play Store install.
#
# That same production build is also the single biggest realism win: real GMS,
# a real Play-certified fingerprint, and a device profile that reports itself
# like the physical phone it emulates.
#
# Play images are heavier, so if the preferred image cannot boot we fall back to
# the known-good API 28 image instead of leaving the site offline.
set -uo pipefail

PREFERRED_API="${PREFERRED_API:-34}"
FALLBACK_API="${FALLBACK_API:-28}"
AVD_NAME="${AVD_NAME:-vexa_android}"
DEVICE_PROFILE="${DEVICE_PROFILE:-pixel_6}"

ANDROID_HOME="${ANDROID_HOME:-/usr/local/lib/android/sdk}"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
export ANDROID_AVD_HOME="${ANDROID_AVD_HOME:-$HOME/.android/avd}"
mkdir -p "$ANDROID_AVD_HOME"

log() { echo "[boot] $*"; }

install_image() {
  local api="$1" tag="$2"
  local pkg="system-images;android-${api};${tag};x86_64"
  log "installing $pkg"
  sdkmanager "$pkg" "platforms;android-${api}" >/dev/null 2>&1 || return 1
  [ -d "$ANDROID_HOME/system-images/android-${api}/${tag}/x86_64" ]
}

create_avd() {
  local api="$1" tag="$2" name="$3"
  rm -rf "$ANDROID_AVD_HOME/${name}.avd" "$ANDROID_AVD_HOME/${name}.ini" 2>/dev/null || true
  echo "no" | avdmanager create avd -n "$name" \
    -k "system-images;android-${api};${tag};x86_64" \
    -d "$DEVICE_PROFILE" --force >/dev/null 2>&1 || return 1
  [ -f "$ANDROID_AVD_HOME/${name}.ini" ]
}

boot_avd() {
  local name="$1" timeout_s="${2:-600}"
  log "booting $name"
  adb kill-server >/dev/null 2>&1 || true
  adb start-server >/dev/null 2>&1 || true
  nohup emulator -avd "$name" \
    -no-window -gpu swiftshader_indirect \
    -noaudio -no-boot-anim -no-snapshot \
    -memory 3072 -cores 2 \
    > /tmp/emulator.log 2>&1 &
  echo $! > /tmp/emulator.pid

  local deadline=$(( $(date +%s) + timeout_s ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if adb devices 2>/dev/null | grep -q "emulator-5554[[:space:]]*device"; then
      if [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then
        log "boot completed"
        return 0
      fi
    fi
    # A crashed emulator never recovers on its own; stop waiting for it.
    if [ -f /tmp/emulator.pid ] && ! kill -0 "$(cat /tmp/emulator.pid)" 2>/dev/null; then
      log "emulator process exited during boot"
      return 1
    fi
    sleep 5
  done
  log "boot timed out after ${timeout_s}s"
  tail -n 40 /tmp/emulator.log || true
  return 1
}

try_boot() {
  local api="$1" tag="$2" label="$3" timeout_s="${4:-600}"
  log "--- attempting $label (API $api, $tag) ---"
  install_image "$api" "$tag" || { log "image install failed"; return 1; }
  create_avd "$api" "$tag" "$AVD_NAME" || { log "AVD creation failed"; return 1; }
  boot_avd "$AVD_NAME" "${3:-600}" || return 1

  # Record which image actually booted so later steps can adapt.
  {
    echo "BOOTED_API=$api"
    echo "BOOTED_TAG=$tag"
    echo "BOOTED_AVD=$AVD_NAME"
    echo "HAS_PLAY_STORE=$([ "$tag" = "google_apis_playstore" ] && echo true || echo false)"
  } > /tmp/vexa-boot.env
  cat /tmp/vexa-boot.env
  return 0
}

# Play-certified image first: it carries the Play Store and a production build.
if try_boot "$PREFERRED_API" "google_apis_playstore" "Play Store image" 720; then
  log "using Play Store image"
  exit 0
fi

log "Play image unavailable; falling back to the known-good image"
adb emu kill >/dev/null 2>&1 || true
sleep 5
if try_boot "$FALLBACK_API" "google_apis" "fallback image" 480; then
  log "using fallback image (no Play Store)"
  exit 0
fi

log "::error::no emulator image booted"
exit 1
