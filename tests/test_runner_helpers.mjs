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
import { formatUiElements, mapActionToMobilerun, verifyClaim, recoveryAppFor, normalizeDecisionAction, uiHierarchyToText, parseCompletion } from '../agent/runner.mjs';

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

test('normalizeDecisionAction strips the suffix even when x/y are also set', () => {
  // Regression: the model returned action "tap(540,1377)" AND x/y, so the old
  // guard (only run when x/y were empty) left the suffix on and the gateway
  // rejected every step with 'Invalid action: tap(540,1377)'.
  const d = normalizeDecisionAction({ action: 'tap(540,1377)', x: 540, y: 1377 }, 'open calculator');
  assert.equal(d.action, 'tap');
  assert.equal(d.x, 540);
  assert.equal(d.y, 1377);
});

test('normalizeDecisionAction parses launch(Calculator) into a name', () => {
  const d = normalizeDecisionAction({ action: 'launch(Calculator)' }, 'open calculator');
  assert.equal(d.action, 'launch');
  assert.equal(d.text, 'Calculator');
  assert.ok(!d.text.includes('.'), 'a name, not a package');
});

test('normalizeDecisionAction rejects coordinate-like launch args', () => {
  const d = normalizeDecisionAction({ action: 'launch(0,0)' }, 'open calculator');
  assert.equal(d.action, 'launch');
  assert.equal(d.text, 'Calculator');
});

test('normalizeDecisionAction leaves a clean action untouched', () => {
  const d = normalizeDecisionAction({ action: 'home' }, 'x');
  assert.equal(d.action, 'home');
});

test('uiHierarchyToText parses a base64 uiautomator dump into tap targets', () => {
  // Regression: the gateway stores the raw dump base64-encoded, and the runner
  // handed it to the model verbatim, so the model had no coordinates.
  const xml = '<?xml version="1.0"?><hierarchy rotation="0">'
    + '<node index="0" text="Calculator" resource-id="" class="android.widget.TextView" package="com.android.calculator2" content-desc="" clickable="true" bounds="[100,200][300,400]"/>'
    + '<node index="1" text="7" class="android.widget.Button" package="com.android.calculator2" content-desc="" clickable="true" bounds="[10,20][110,120]"/>'
    + '</hierarchy>';
  const out = uiHierarchyToText(Buffer.from(xml).toString('base64'));
  assert.match(out, /package=com\.android\.calculator2/);
  assert.match(out, /"Calculator" tap\(200,300\)/);
  assert.match(out, /"7" tap\(60,70\)/);
});

test('uiHierarchyToText passes through already-formatted bridge text', () => {
  const text = 'package=com.android.settings (1 labeled elements)\n- "Battery" tap(255,1420) bounds=[0,0,100,100] clickable';
  assert.equal(uiHierarchyToText(text), text);
});

test('uiHierarchyToText returns null for junk input', () => {
  assert.equal(uiHierarchyToText(null), null);
  assert.equal(uiHierarchyToText('DUMPSYS_WINDOWS:whatever'), null);
});

console.log(`\n${passed} passed, 0 failed`);

// ── parseCompletion: reasoning-model responses ──────────────────────────────
// NVIDIA nemotron returns the JSON decision in `reasoning_content` with
// `content: null`. Reading `content` alone made the reply empty and the agent
// launched the Play Store instead of continuing the task.
test('parseCompletion reads content when present', () => {
  const json = { choices: [{ message: { content: '{"action":"tap","x":1,"y":2}' } }] };
  assert.equal(parseCompletion(json), '{"action":"tap","x":1,"y":2}');
});

test('parseCompletion falls back to reasoning_content when content is null', () => {
  const json = { choices: [{ message: { content: null, reasoning_content: '{"action":"launch","app":"Calculator"}' } }] };
  assert.equal(parseCompletion(json), '{"action":"launch","app":"Calculator"}');
});

test('parseCompletion throws a clear error on an empty completion', () => {
  const json = { choices: [{ message: { content: null }, finish_reason: 'length' }] };
  assert.throws(() => parseCompletion(json, 'nvidia'), /empty completion/);
});

test('parseCompletion strips thinking tags before returning', () => {
  const json = { choices: [{ message: { content: '<thinking>hmm</thinking>{"action":"home"}' } }] };
  assert.equal(parseCompletion(json), '{"action":"home"}');
});
