// Mirrors Wrangler's Text rule: import a .py file as a string.
import { readFileSync } from 'node:fs';

export async function load(url, context, nextLoad) {
  if (url.endsWith('.py')) {
    const source = JSON.stringify(readFileSync(new URL(url), 'utf8'));
    return { format: 'module', shortCircuit: true, source: `export default ${source};` };
  }
  return nextLoad(url, context);
}
