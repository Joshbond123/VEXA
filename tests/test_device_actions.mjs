/**
 * Regression tests for device-action coordinate normalisation.
 *
 * The chat model emits normalised (0..1) coordinates. Those were queued
 * verbatim and the emulator ran `input tap 0 0`, so every chat tap hit the
 * top-left corner and the phone looked frozen ("queued device action ... wait").
 *
 * Run: node tests/test_device_actions.mjs
 */
import assert from 'node:assert/strict';
import { normalizeDeviceAction, resolutionFromSession, DEFAULT_RESOLUTION } from '../cloudflare-backend/src/device-actions.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n    ${err.message}`); process.exitCode = 1; }
}

const RES = { width: 1080, height: 2400 };

test('fractional tap coordinates are scaled to pixels', () => {
  const a = normalizeDeviceAction({ action: 'tap', x: 0.5, y: 0.25 }, RES);
  assert.equal(a.x, 540);
  assert.equal(a.y, 600);
});

test('pixel coordinates are left untouched', () => {
  const a = normalizeDeviceAction({ action: 'tap', x: 540, y: 1200 }, RES);
  assert.equal(a.x, 540);
  assert.equal(a.y, 1200);
});

test('a normalised swipe scales all four endpoints', () => {
  const a = normalizeDeviceAction({ action: 'swipe', x1: 0.5, y1: 0.8, x2: 0.5, y2: 0.2 }, RES);
  assert.deepEqual([a.x1, a.y1, a.x2, a.y2], [540, 1920, 540, 480]);
});

test('the chat-model action that produced the bug now lands on screen', () => {
  const a = normalizeDeviceAction({ action: 'tap', x: 0.1639, y: 0.0205 }, RES);
  assert.ok(a.x > 100 && a.x < 300, `x was ${a.x}`);
  assert.ok(a.y > 20 && a.y < 100, `y was ${a.y}`);
});

test('non-coordinate actions pass through unchanged', () => {
  const a = normalizeDeviceAction({ action: 'launch', app: 'Settings' }, RES);
  assert.equal(a.action, 'launch');
  assert.equal(a.app, 'Settings');
});

test('resolutionFromSession parses "WxH" and falls back on junk', () => {
  assert.deepEqual(resolutionFromSession({ resolution: '1080x2400' }), { width: 1080, height: 2400 });
  assert.deepEqual(resolutionFromSession({ resolution: '1080×1920' }), { width: 1080, height: 1920 });
  assert.deepEqual(resolutionFromSession({}), DEFAULT_RESOLUTION);
});

console.log(`\n${passed} passed, ${process.exitCode ? 'some failed' : '0 failed'}`);
