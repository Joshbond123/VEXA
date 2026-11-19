#!/usr/bin/env node
/**
 * Guards the emulator-rotation wiring.
 *
 * Run 45 failed in "Install dependencies" because apt could not reach
 * security.ubuntu.com, and because nothing retried or re-dispatched, the site
 * reported the emulator offline for over 10 hours. These tests pin the two
 * things that prevent a repeat: the deps step must not be fatal on a transient
 * apt failure, and a watchdog must exist to re-dispatch a dead rotation.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const wf = (name) => readFileSync(join(ROOT, '.github/workflows', name), 'utf8');

await test('rotation keeps a 4-hour cadence', async () => {
  const y = wf('android-emulator.yml');
  assert.match(y, /cron:\s*'0 \*\/4 \* \* \*'/, 'the rotation must stay on a 4-hour cron');
});

await test('a transient apt failure cannot kill the rotation', async () => {
  const y = wf('android-emulator.yml');
  const step = y.slice(y.indexOf('name: Install dependencies'), y.indexOf('name: Install Android SDK Command-line Tools'));
  assert.ok(step.includes('for attempt in 1 2 3'), 'the deps step must retry');
  assert.ok(step.includes('Acquire::Retries'), 'apt itself should retry downloads');
  assert.ok(
    /apt install failed after 3 attempts; continuing/.test(step),
    'the deps step must continue rather than fail the job when apt is unreachable',
  );
  // The binaries the boot genuinely needs must still be asserted.
  for (const bin of ['curl', 'wget', 'unzip', 'java']) {
    assert.ok(step.includes(bin), `the deps step must still require ${bin}`);
  }
});

await test('a watchdog re-dispatches an offline emulator', async () => {
  assert.ok(existsSync(join(ROOT, '.github/workflows/emulator-watchdog.yml')), 'watchdog workflow must exist');
  const y = wf('emulator-watchdog.yml');
  assert.ok(y.includes('/api/frontend/emulator-status'), 'the watchdog must read real device status');
  assert.ok(y.includes('/dispatches'), 'the watchdog must be able to dispatch the rotation');
  assert.ok(y.includes("status' in ('queued'") || y.includes("queued|in_progress"), 'the watchdog must not stack runs');
});

await test('watchdog treats queued and in-progress runs as already active', async () => {
  // Same pipeline the workflow runs, against fixtures. A watchdog that cannot
  // see a queued run would dispatch on every tick and starve the concurrency
  // group, so the device would never actually boot.
  const count = (json) =>
    json
      .split('\n')
      .map((l) => l.match(/"status": *"([a-z_]+)"/))
      .filter(Boolean)
      .map((m) => m[1])
      .filter((s) => ['queued', 'in_progress', 'waiting', 'pending'].includes(s)).length;

  assert.equal(count('{"status": "queued"}\n{"status": "completed"}'), 1, 'a queued run counts as active');
  assert.equal(count('{"status": "in_progress"}'), 1, 'an in-progress run counts as active');
  assert.equal(count('{"status": "completed"}\n{"status": "failure"}'), 0, 'finished runs do not block a dispatch');
});

await test('the emulator boots a Play-capable image first, with a fallback', async () => {
  const s = readFileSync(join(ROOT, 'android-emulator/boot-emulator.sh'), 'utf8');
  assert.ok(s.includes('google_apis_playstore'), 'the Play Store ships only in the playstore image');
  assert.ok(s.includes('fallback image'), 'a Play image failure must not leave the site offline');
  // Boot ordering: Play attempt must come before the fallback attempt.
  assert.ok(
    s.indexOf('Play Store image" 720') < s.indexOf('fallback image" 480'),
    'the Play image must be attempted before the fallback',
  );
});

await test('realism script does not claim to defeat Play Integrity', async () => {
  const s = readFileSync(join(ROOT, 'android-emulator/real-device-profile.sh'), 'utf8');
  // Honesty guard: the script may tune settings, but it must not pretend to
  // forge hardware attestation, which no emulator can do.
  assert.ok(/CANNOT: pass Play Integrity/.test(s), 'the script must document what it cannot do');
  // Match actual invocations, not prose that explains why they are avoided.
  assert.ok(!/^\s*(adb shell )?(resetprop|magisk)\b/mi.test(s), 'the script must not run attestation spoofing tools');
  assert.ok(!/keybox/i.test(s.replace(/stolen keybox/g, '')), 'the script must not use a keybox');
});

await test('play store presence is verified, not assumed', async () => {
  const y = wf('android-emulator.yml');
  assert.ok(y.includes('Verify Google Play Store'), 'the workflow must verify the store');
  assert.ok(y.includes('com.android.vending'), 'verification must check the real package');
  assert.ok(y.includes('PLAY_STORE_PRESENT'), 'the result must be recorded');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
