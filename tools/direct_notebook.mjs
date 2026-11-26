// Builds kaggle/vexa-direct.ipynb: the runtime in direct mode, ready to run by hand
// when the control plane is unavailable or its Durable Object quota is spent.
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildKernel } from '../src/kernel.js';

const source = buildKernel({
  direct: true,
  dataset: 'black797/vexa-qwen38-q6k',
  modelFile: 'Qwen3.8-27B-Uncensored-Q6_K.gguf',
  servedModel: 'qwen3.8-27b-uncensored-q6_k',
  ctx: 32768,
  parallel: 2,
});

const intro = [
  '# VEXA direct GPU endpoint',
  '',
  'Serves Qwen straight from this notebook. Inference never passes through the',
  'Worker or its Durable Objects, so no Cloudflare quota applies.',
  '',
  'Before running:',
  '',
  '1. Settings -> Accelerator -> **GPU T4 x2**.',
  '2. Settings -> Internet -> **on** (needed for cloudflared and any download).',
  '3. Add the model dataset as input: `black797/vexa-qwen38-q6k`.',
  '4. Run all. The last lines print a base URL and an API key; paste both into your',
  '   OpenAI/OpenHands profile. The URL is new on every start.',
  '',
  'Setting `VEXA_DIRECT_KEY` in the notebook keeps the key stable across restarts.',
];

const cell = (kind, lines, extra = {}) => ({
  cell_type: kind,
  metadata: {},
  source: lines.map((line, i) => (i === lines.length - 1 ? line : line + '\n')),
  ...extra,
});

const notebook = {
  cells: [
    cell('markdown', intro),
    cell('code', source.split('\n'), { execution_count: null, outputs: [] }),
  ],
  metadata: {
    kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
    language_info: { name: 'python' },
  },
  nbformat: 4,
  nbformat_minor: 5,
};

mkdirSync('kaggle', { recursive: true });
writeFileSync('kaggle/vexa-direct.ipynb', JSON.stringify(notebook, null, 1) + '\n');
console.log(`kaggle/vexa-direct.ipynb: 1 code cell, ${source.split('\n').length} lines`);
