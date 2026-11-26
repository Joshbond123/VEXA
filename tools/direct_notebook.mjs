// Builds kaggle/vexa-direct.ipynb: the runtime in direct mode, ready to run by hand
// when the control plane is unavailable or its Durable Object quota is spent.
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildKernel } from '../src/kernel.js';

// Secrets come from the environment so the committed notebook only ever holds
// placeholders; CI fills them in before pushing to Kaggle.
const env = (name, fallback) => (process.env[name] || fallback).trim();

const source = buildKernel({
  direct: true,
  directApiKey: env('VEXA_DIRECT_KEY', '<MODEL_KEY>'),
  ngrokAuthtoken: env('VEXA_NGROK_AUTHTOKEN', '<NGROK_AUTHTOKEN>'),
  ngrokDomain: env('VEXA_NGROK_DOMAIN', '<NGROK_DOMAIN>'),
  dataset: 'black797/vexa-qwen38-q6k',
  modelFile: 'Qwen3.8-27B-Uncensored-Q6_K.gguf',
  servedModel: 'qwen3.8-27b-uncensored-q6_k',
  // One slot, so a single request gets the whole context. Two slots halved it to
  // 16k each, and an agent's system prompt plus tool schemas does not fit in that:
  // llama-server answered 400 and the client looked silent.
  ctx: 32768,
  parallel: 1,
});

const intro = [
  '# VEXA direct GPU endpoint',
  '',
  'Serves Qwen from this notebook over the ngrok static domain in the config.',
  'There is no Cloudflare Worker, relay or Durable Object anywhere in the path:',
  'OpenHands talks to ngrok, ngrok talks to this notebook.',
  '',
  'Before running:',
  '',
  '1. Settings -> Accelerator -> **GPU T4 x2**.',
  '2. Settings -> Internet -> **on**.',
  '3. Add the model dataset as input: `black797/vexa-qwen38-q6k`.',
  '4. Run all. The domain is fixed, so the base URL never changes between starts.',
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
