/**
 * Regression tests for the VEXA agent runner's pure helpers.
 *
 * `formatUiElements` is what turns the live accessibility tree into the text the
 * model reads. It used to be fed raw uiautomator XML (or nothing at all, because
 * the bridge returns a parsed object), so the agent had no reliable tap targets.
 * `mapActionToMobilerun` is the action → bridge-endpoint contract.
 *
 * Run: node tests/test_runner_helpers.mjs
 */
import assert from 'node:assert/strict';
import { formatUiElements, mapActionToMobilerun, verifyClaim, recoveryAppFor } from '../agent/runner.mjs';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n    ${err.message}`); process.exitCode = 1; }
}

test('formatUiElements emits exact tap centres from bounds', () => {
  const out = formatUiElements([
    { text: 'Network & internet', content_description: null, clickable: true, bounds: { left: 189, top: 101, right: 632, bottom: 172 } },
  ], 'com.android.settings');
  assert.match(out, /package=com\.android\.settings/);
  assert.match(out, /"Network & internet" tap\(411,137\)/);
  assert.match(out, /clickable/);
});

test('formatUiElements falls back to contentDescription when text is empty', () => {
  const out = formatUiElements([
    { text: '', content_description: 'Navigate up', clickable: true, bounds: { left: 0, top: 63, right: 147, bottom: 210 } },
  ], 'com.android.settings');
  assert.match(out, /"Navigate up" tap\(74,137\)/);
});

test('formatUiElements drops elements without bounds (no bogus coordinates)', () => {
  const out = formatUiElements([
    { text: 'Has bounds', bounds: { left: 0, top: 0, right: 100, bottom: 100 } },
    { text: 'No bounds', bounds: null },
  ], 'pkg');
  assert.match(out, /"Has bounds"/);
  assert.ok(!out.includes('No bounds'), 'an element without bounds must be skipped');
});

test('formatUiElements returns null for empty/absent element lists', () => {
  assert.equal(formatUiElements([], 'pkg'), null);
  assert.equal(formatUiElements(undefined, 'pkg'), null);
  assert.equal(formatUiElements([{ text: 'x', bounds: null }], 'pkg'), null);
});

test('formatUiElements collapses whitespace and truncates long labels', () => {
  const longLabel = 'A'.repeat(200);
  const out = formatUiElements([
    { text: 'line\n\none', bounds: { left: 0, top: 0, right: 10, bottom: 10 } },
    { text: longLabel, bounds: { left: 0, top: 0, right: 10, bottom: 10 } },
  ], 'pkg');
  assert.match(out, /"line one"/);
  assert.ok(!out.includes(longLabel), 'labels must be truncated to keep the prompt small');
});

test('mapActionToMobilerun maps every supported action to a bridge endpoint', () => {
  assert.deepEqual(mapActionToMobilerun('tap', { x: 10, y: 20 }), { endpoint: '/device/tap', body: { x: 10, y: 20 } });
  assert.equal(mapActionToMobilerun('home', {}).endpoint, '/device/key');
  assert.equal(mapActionToMobilerun('home', {}).body.keycode, 3);
  assert.equal(mapActionToMobilerun('back', {}).body.keycode, 4);
  assert.equal(mapActionToMobilerun('launch', { text: 'com.android.settings' }).body.package, 'com.android.settings');
  assert.equal(mapActionToMobilerun('type', { text: 'hello' }).body.text, 'hello');
});

test('mapActionToMobilerun returns null for actions with no bridge equivalent', () => {
  assert.equal(mapActionToMobilerun('done', {}), null);
  assert.equal(mapActionToMobilerun('fail', {}), null);
});

test('verifyClaim accepts a result that is actually on screen', () => {
  const ui = 'package=com.android.calculator2\n  "10541" tap(540,300)';
  const r = verifyClaim(ui, 'The calculator shows 127 × 83 = 10,541.');
  assert.equal(r.checked, true);
  assert.equal(r.value, '10541');
  assert.equal(r.verified, true);
});

test('verifyClaim rejects a result the agent invented', () => {
  // Regression: the agent reported 10,541 while the screen still showed '3'.
  const ui = 'package=com.android.calculator2\n  "3" tap(540,300)';
  const r = verifyClaim(ui, 'The calculator shows 127 × 83 = 10,541.');
  assert.equal(r.checked, true);
  assert.equal(r.verified, false);
});

test('verifyClaim does not block a non-numeric completion', () => {
  assert.equal(verifyClaim('some tree', 'I opened the Settings app.').checked, false);
  assert.equal(verifyClaim(null, 'result 42').checked, false);
});

test('recoveryAppFor returns a launchable name, never a package', () => {
  assert.equal(recoveryAppFor('Open the Calculator app and compute'), 'Calculator');
  assert.equal(recoveryAppFor('Open Settings and check the Android version'), 'Settings');
  assert.equal(recoveryAppFor('Install Google Keep from the Play Store'), 'Play Store');
  assert.ok(!recoveryAppFor('open the calculator').includes('.'), 'must be a name the device can resolve');
});

console.log(`\n${passed} passed, 0 failed`);
