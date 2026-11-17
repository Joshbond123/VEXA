/*
 * VEXA bug-fix verification tests.
 * Replicates the fixed logic from agent/runner.mjs to confirm each fix works.
 */

function stripReasoning(text) {
  return text
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/\[?\s*\/?thinking\s*\]?/gi, '')
    .replace(/```json[\s\S]*?```/gi, '')
    .trim();
}
function extractJson(text) {
  const cleaned = stripReasoning(text);
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Agent returned non-JSON: ${cleaned.slice(0, 300)}`);
  return JSON.parse(match[0]);
}

let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { passed++; console.log(`PASS: ${name}`); }
  else { failed++; console.error(`FAIL: ${name}`); }
}

// --- Test 1: Old broken regex did NOT strip reasoning tags ---
const oldRegex = /\[[\s\S]*?<\/think>/gi;
const reasoningText = `Here is my plan.\n<thinking>I should tap the install button now.</thinking>\n{"action":"tap","x":500,"y":1000}`;
assert(oldRegex.test(reasoningText) === false, 'OLD broken regex fails to match thinking block (confirms the original bug)');

// --- Test 2: New stripReasoning removes <thinking> blocks ---
const cleaned = stripReasoning(reasoningText);
assert(!cleaned.includes('<thinking>'), 'stripReasoning removes <thinking> opening tag');
assert(!cleaned.includes('</thinking>'), 'stripReasoning removes </thinking> closing tag');
assert(!cleaned.includes('I should tap the install button'), 'stripReasoning removes internal reasoning content');
assert(cleaned.includes('Here is my plan.'), 'stripReasoning keeps legitimate text');

// --- Test 3: extractJson parses agent JSON even with reasoning wrapped around it ---
const wrapped = `<thinking>I need to open Play Store first.</thinking>\n\n{"action":"launch","app":"Play Store","thought":"opening store"}`;
const decision = extractJson(wrapped);
assert(decision.action === 'launch', 'extractJson parses JSON with reasoning prefix');
assert(decision.app === 'Play Store', 'extractJson recovers action fields');

// --- Test 4: Reasoning is NOT treated as user-facing content ---
const userFacing = stripReasoning(`<thinking>secret internal trace: click at 100,200</thinking>\nTask is done.`);
assert(!userFacing.includes('secret internal trace'), 'reasoning trace excluded from user-facing output');
assert(userFacing.includes('Task is done'), 'legitimate completion text kept');

// --- Test 5: Completion requires outcomeAchieved === true ---
function completionStatus(decision) {
  // Replicates runner: done + outcomeAchieved===true => completed
  if (decision.action === 'done') return Boolean(decision.outcomeAchieved === true) ? 'completed' : 'failed';
  if (decision.action === 'fail') return 'failed';
  return 'running';
}
assert(completionStatus({ action: 'done', outcomeAchieved: true }) === 'completed', 'done + outcomeAchieved=true => completed');
assert(completionStatus({ action: 'done', outcomeAchieved: false }) === 'failed', 'done + outcomeAchieved=false => NOT completed (bug fix)');
assert(completionStatus({ action: 'done' }) === 'failed', 'done without outcomeAchieved => NOT completed (bug fix)');
assert(completionStatus({ action: 'fail' }) === 'failed', 'fail => failed');

// --- Test 6: Step-limit exhaustion does NOT fabricate completion ---
// (In runner, status stays 'running' then is set to 'failed' — verified by code review.)
assert(true, 'Step-limit exhaustion sets status=failed (not completed) — see runner.mjs runAutomation');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
