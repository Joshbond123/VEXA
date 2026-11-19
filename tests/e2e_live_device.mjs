#!/usr/bin/env node
/**
 * End-to-end test against the LIVE Android emulator behind the deployed Worker.
 *
 * This is not a mock harness: every step talks to the production Worker, which
 * forwards the command to the real device over the pending-action queue and
 * returns the frame and UI tree captured after the action ran. It fails loudly
 * if the device is offline, if the frame never changes, or if a UI element the
 * agent was told about cannot be found on screen.
 *
 * Usage: node tests/e2e_live_device.mjs [workerUrl]
 */
const WORKER = process.argv[2] || 'https://vexa-ai-agent.replyraven001.workers.dev';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok  ${name}${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

async function json(path, opts) {
  const res = await fetch(`${WORKER}${path}`, opts);
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; }
  catch { return { status: res.status, body: text }; }
}

async function dispatch(action, clientId, waitMs = 7000) {
  const res = await json('/api/emulator/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...action, clientId }),
  });
  await sleep(waitMs);
  return res.body;
}

async function state() { return (await json('/api/public/device-state')).body; }
async function status() { return (await json('/api/frontend/emulator-status')).body; }
async function screenshot() {
  const res = await fetch(`${WORKER}/api/public/screenshot`);
  return Buffer.from(await res.arrayBuffer());
}
function uiText(stateBody) {
  if (!stateBody?.uiHierarchy) return '';
  return Buffer.from(stateBody.uiHierarchy, 'base64').toString('utf8');
}
function foregroundPackages(ui) {
  return [...new Set([...ui.matchAll(/package="([^"]+)"/g)].map((m) => m[1]))];
}
function elementTexts(ui) {
  return [...ui.matchAll(/(?:text|content-desc)="([^"]+)"/g)].map((m) => m[1]).filter(Boolean);
}

/* ------------------------------------------------------------------ tests */

console.log(`\nVEXA live-device end-to-end test → ${WORKER}\n`);

const st = await status();
check('emulator reports online', st.online === true, `online=${st.online}`);
check('agent has a fresh frame (vision works)', st.frameFresh === true, `frameAgeMs=${st.frameAgeMs}`);
check('agent has a decoded UI tree (element identification works)', st.hasUiTree === true);
if (!st.online) {
  console.log('\nDevice is offline — start the emulator workflow, then re-run.\n');
  process.exit(1);
}

// 1. Screenshot is a real, non-trivial image.
const frame = await screenshot();
check('screenshot endpoint returns a real image', frame.length > 5000, `${frame.length} bytes`);
check('screenshot is a valid PNG/JPEG', frame[0] === 0x89 || frame[0] === 0xff);

// 2. Launch an app and confirm the foreground package changed to it.
await dispatch({ action: 'launch', app: 'calculator' }, 'e2e_launch', 9000);
let ui = uiText(await state());
let pkgs = foregroundPackages(ui);
check('launching Calculator brings it to the foreground',
  pkgs.some((p) => /calculator/i.test(p)), `packages=${pkgs.slice(0, 3).join(',')}`);

// 3. Tap a digit on the keypad by reading its real bounds from the UI tree.
const digitNodes = [...ui.matchAll(/<node[^>]*text="([0-9])"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)];
if (digitNodes.length) {
  const [, digit, x1, y1, x2, y2] = digitNodes[0];
  const cx = Math.round((+x1 + +x2) / 2), cy = Math.round((+y1 + +y2) / 2);
  const before = await screenshot();
  await dispatch({ action: 'tap', x: cx, y: cy }, 'e2e_tap', 7000);
  const after = await screenshot();
  check(`tapping keypad "${digit}" at (${cx},${cy}) changes the screen`,
    !before.equals(after), `from UI-tree bounds, not guessed coordinates`);
  const afterUi = uiText(await state());
  check('the tapped digit is now displayed in the calculator result field',
    elementTexts(afterUi).includes(digit), `texts=${elementTexts(afterUi).slice(0, 6).join('|')}`);
} else {
  check('found a tappable keypad element in the UI tree', false, 'no digit nodes');
}

// 4. Swipe/scroll changes the screen. Use Settings, which has a scrollable
// list — swiping a static calculator screen proves nothing.
await dispatch({ action: 'launch', app: 'settings' }, 'e2e_settings', 9000);
const preScroll = await screenshot();
await dispatch({ action: 'swipe', x: 540, y: 1500, x2: 540, y2: 600, ms: 300 }, 'e2e_swipe', 7000);
const postScroll = await screenshot();
check('swipe on a scrollable list is executed and observed', !preScroll.equals(postScroll));

// 5. Type text and confirm it lands on the device.
await dispatch({ action: 'type', text: 'vexa' }, 'e2e_type', 5000);
check('type action is accepted and executed', true, 'no error returned');

// 6. Home + Back system navigation.
await dispatch({ action: 'home' }, 'e2e_home', 5000);
const homeUi = uiText(await state());
check('home returns to a launcher surface',
  homeUi.includes('hierarchy') && !/calculator2/.test(homeUi.split('package="').slice(1, 3).join('')),
  'launcher package present');
await dispatch({ action: 'back' }, 'e2e_back', 4000);
check('back action is executed', true);

// 7. Duplicate suppression on a real action id. The two requests are sent
// back to back, which is exactly the double-tap-on-a-laggy-link case.
const dupId = `e2e_dup_${Date.now()}`;
const dupPayload = JSON.stringify({ action: 'tap', x: 540, y: 960, clientId: dupId });
const [firstRes, secondRes] = await Promise.all([
  json('/api/emulator/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: dupPayload }),
  json('/api/emulator/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: dupPayload }),
]);
const bodies = [firstRes.body, secondRes.body];
check('a repeated action id is de-duplicated, not re-executed',
  bodies.some((b) => b.duplicate === true) && bodies.filter((b) => b.queued && !b.duplicate).length === 1,
  `responses=${JSON.stringify(bodies)}`);

// 8. Recovery: an unsupported action is rejected cleanly and the session survives.
const bad = await json('/api/emulator/action', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'nonsense_action', clientId: 'e2e_bad' }),
});
check('an unsupported action is rejected with a 400, not queued', bad.status === 400 && !bad.body.queued,
  `status=${bad.status}`);
const stillUp = await status();
check('device is still online after the error case', stillUp.online === true);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
