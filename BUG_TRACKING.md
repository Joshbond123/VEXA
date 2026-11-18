# VEXA Bug Tracking Checklist

**Status key:** OPEN | IN_PROGRESS | FIXED | BLOCKED | CLOSED

---

## BUG-001: AI Agent Cannot See or Control Android Emulator (CRITICAL)

**Status:** BLOCKED

**Description:** The AI agent cannot see or control the Android emulator because headless CI screenshot capture fails. `adb exec-out screencap -p`, `adb shell screencap -p`, and `/system/bin/screencap` all produce a 1x1 green pixel on headless (-no-window) emulators. `uiautomator dump` returns null. Root cause: headless emulator with `-gpu swiftshader_indirect -no-window` has no accessible framebuffer for screencap or uiautomator.

**Reproduction:**
1. Start Android emulator on GitHub Actions ubuntu-26.04 with `-no-window -gpu swiftshader_indirect`
2. Run `adb exec-out screencap -p` → 1x1 green pixel
3. Run `adb shell uiautomator dump` → null/empty

**Investigation:**
- Xvfb + swiftshader_indirect + NO -no-window: FAILED (emulator never boots, adb device not found, reactivecircus/android-emulator-runner times out) — commit 4ffc3dd, run 44270884285
- reactivecircus/android-emulator-runner with Xvfb :99: FAILED (stuck, no logs after 10+ min) — runs 44261895675, 44273308244
- Manual Android SDK setup + direct emulator start: STUCK (no logs after 3+ min) — run 44274197148, 44275408442
- Manual Android SDK setup with google_apis API 30 (lighter image): STUCK (same no-logs issue) — run 44275408442

**Fix attempted:**
- `run-emulator-session.sh`: Multi-method screenshot capture (screenrecord+ffmpeg, exec-out screencap, screencap to /sdcard pull), UI hierarchy via uiautomator dump + dumpsys fallback, Cloudflare Worker as permanent gateway
- `.github/workflows/android-emulator.yml`: Multiple iterations (Xvfb, reactivecircus runner, manual SDK setup)

**Next steps:**
- Try API level 28 google_apis image (smaller, faster boot)
- Try without -wipe-data for persistence
- Try different GitHub Actions runner (ubuntu-24.04 vs ubuntu-26.04)
- Consider scrcpy H.264 screen mirroring via ADB tunnel as alternative to screenrecord+ffmpeg

**Impact:** Calculator Math Task (auto_calculator_math_1) cannot be verified. Agent launches com.google.android.calculator and types 127*83= but cannot verify result due to green screen. Mathematical result 127 × 83 = 10,541 (unverified on device).

---

## BUG-002: Settings Page Nav Label Confusing

**Status:** FIXED

**Description:** Settings page nav item was labeled "AI Providers" instead of "Settings", making it hard for users to find.

**Fix:** Renamed nav item to "Settings" in both desktop sidebar and mobile drawer (commit 8f00150).

**Verification:** Settings page accessible from navigation, routes work, load/save persist via Cloudflare KV, credentials secure backend-only.

---

## BUG-003: Google Account Credentials Missing for Android Sign-in

**Status:** OPEN

**Description:** Google account email replyraven001@gmail.com found but NO password found anywhere. Android sign-in blocker prevents email persistence on VEXA emulator.

**Impact:** Cannot log in to Google account on emulator, cannot preserve email session, cannot use Play Store with purchased/installed apps.

**Next steps:** User needs to provide Google account password or app-specific password.

---

## BUG-004: Calculator Math Task E2E Test Fails

**Status:** BLOCKED (depends on BUG-001)

**Description:** auto_calculator_math_1 — open Calculator, compute 127 × 83 = 10,541, verify result. Agent launches com.google.android.calculator correctly and types 127*83= but cannot verify due to green screen (BUG-001).

**Status:** FAILED — outcome False, result 10,541 unverified.

**Impact:** 1 of 12 mandatory E2E tests cannot pass until emulator screenshot access is fixed.

---

## Implementation Notes

**Screenrecord+ffmpeg approach (committed in run-emulator-session.sh):**
- Continuous `adb shell screenrecord` H.264 stream to /sdcard/vexa_record.mp4
- ffmpeg extracts individual PNG frames from the video file
- Fallbacks: `adb exec-out screencap -p`, `adb shell screencap -p /sdcard/` then pull
- UI hierarchy: `adb shell uiautomator dump /sdcard/vexa_ui.xml` + `dumpsys window windows` fallback
- All screenshots + UI hierarchy uploaded to Cloudflare Worker `/api/emulator/screenshot`
- Frontend polls `/api/public/screenshot` and `/api/public/device-state`

**Cloudflare Worker (deployed: version b9a51a99):**
- https://vexa-ai-agent.replyraven001.workers.dev
- Endpoints: /api/public/health, /api/public/screenshot, /api/public/device-state, /api/emulator/*
- D1 database: 43090570-0d1a-4ff5-976a-d23a653df304
- KV namespaces: CONFIG_KV, SESSION_KV

**GitHub Pages (deployed):**
- https://joshbond123.github.io/VEXA/

**GitHub Secrets configured (5):**
- NVIDIA_API_KEY, EMULATOR_ACCESS_TOKEN, EMULATOR_GATEWAY_SECRET, GH_PAT, EMULATOR_STATE_KEY

---
