import { parseDurationSeconds, truncate } from './util.js';

const API = 'https://api.kaggle.com/v1';
const SERVICE_KERNELS = 'kernels.KernelsApiService';
const SERVICE_DATASETS = 'datasets.DatasetApiService';

export class KaggleError extends Error {
  constructor(message, status = 0, detail = null) {
    super(message);
    this.name = 'KaggleError';
    this.status = status;
    this.detail = detail;
  }
}

async function call(cfg, service, method, body = {}, { timeout = 30000 } = {}) {
  if (!cfg.kaggleKey) throw new KaggleError('Kaggle API key is not configured', 401);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let response;
  try {
    response = await fetch(`${API}/${service}/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.kaggleKey}`,
        'content-type': 'application/json',
        'user-agent': 'vexa-platform/3.0',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    throw new KaggleError(err.name === 'AbortError' ? 'Kaggle API timed out' : `Kaggle API unreachable: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!response.ok) {
    const message = data?.error?.message || data?.message || truncate(text, 300) || `HTTP ${response.status}`;
    if (response.status === 401 || response.status === 403) {
      throw new KaggleError('Kaggle rejected the credentials (unauthorised)', response.status, message);
    }
    throw new KaggleError(message, response.status, data);
  }
  if (data && data.error) {
    throw new KaggleError(data.error.message || 'Kaggle API error', data.error.code || 0, data.error);
  }
  return data || {};
}

export function splitRef(ref) {
  const [owner, slug] = String(ref || '').split('/');
  if (!owner || !slug) throw new KaggleError('Dataset must be in owner/slug form');
  return { owner, slug };
}

export async function quota(cfg) {
  const data = await call(cfg, SERVICE_KERNELS, 'GetAcceleratorQuotaStatistics', {});
  const gpu = data.gpuQuota || {};
  return {
    refreshAt: data.quotaRefreshTime || null,
    gpu: {
      usedSeconds: parseDurationSeconds(gpu.timeUsed),
      reservedSeconds: parseDurationSeconds(gpu.timeReserved),
      totalSeconds: parseDurationSeconds(gpu.totalTimeAllowed),
      minimumSeconds: parseDurationSeconds(gpu.minimumTimeAllowed),
      hasEverRun: !!gpu.hasEverRun,
    },
    tpu: data.tpuQuota
      ? {
          usedSeconds: parseDurationSeconds(data.tpuQuota.timeUsed),
          totalSeconds: parseDurationSeconds(data.tpuQuota.totalTimeAllowed),
        }
      : null,
  };
}

export async function datasetInfo(cfg) {
  const { owner, slug } = splitRef(cfg.dataset);
  const data = await call(cfg, SERVICE_DATASETS, 'GetDataset', { ownerSlug: owner, datasetSlug: slug });
  return {
    exists: true,
    ref: data.ref,
    title: data.title,
    totalBytes: Number(data.totalBytes || 0),
    version: Number(data.currentVersionNumber || 0),
    isPrivate: !!data.isPrivate,
    url: data.url,
    lastUpdated: data.lastUpdated || null,
  };
}

export async function datasetFiles(cfg) {
  const { owner, slug } = splitRef(cfg.dataset);
  const out = [];
  let pageToken = '';
  for (let page = 0; page < 6; page++) {
    const data = await call(cfg, SERVICE_DATASETS, 'ListDatasetFiles', {
      ownerSlug: owner,
      datasetSlug: slug,
      pageSize: 100,
      ...(pageToken ? { pageToken } : {}),
    });
    for (const f of data.datasetFiles || []) out.push({ name: f.name, bytes: Number(f.totalBytes || 0) });
    pageToken = data.nextPageToken || '';
    if (!pageToken) break;
  }
  return out;
}

export async function kernelInfo(cfg) {
  const { owner, slug } = splitRef(cfg.kernelSlug);
  try {
    const data = await call(cfg, SERVICE_KERNELS, 'GetKernel', { userName: owner, kernelSlug: slug });
    const meta = data.metadata || {};
    return {
      exists: true,
      ref: meta.ref,
      version: Number(meta.currentVersionNumber || 0),
      machineShape: meta.machineShape || null,
      enableGpu: !!meta.enableGpu,
      enableInternet: !!meta.enableInternet,
      isPrivate: !!meta.isPrivate,
      lastRun: meta.lastRunTime || null,
    };
  } catch (err) {
    if (err instanceof KaggleError && (err.status === 404 || err.status === 403)) return { exists: false };
    throw err;
  }
}

export async function sessionStatus(cfg) {
  const { owner, slug } = splitRef(cfg.kernelSlug);
  const data = await call(cfg, SERVICE_KERNELS, 'GetKernelSessionStatus', { userName: owner, kernelSlug: slug });
  return {
    status: String(data.status || 'UNKNOWN').toUpperCase(),
    failureMessage: data.failureMessage || '',
    kernelSessionId: data.kernelSessionId || null,
  };
}

export async function pushKernel(cfg, source, { timeoutSeconds = 43200, title = 'VEXA Kaggle GPU runtime', kernelType = 'script' } = {}) {
  const { owner, slug } = splitRef(cfg.kernelSlug);
  const data = await call(cfg, SERVICE_KERNELS, 'SaveKernel', {
    slug: `${owner}/${slug}`,
    newTitle: title,
    text: source,
    language: 'python',
    kernelType,
    isPrivate: true,
    enableGpu: true,
    enableInternet: true,
    machineShape: 'NvidiaTeslaT4',
    sessionTimeoutSeconds: timeoutSeconds,
    datasetDataSources: [cfg.dataset, cfg.toolsDataset].filter(Boolean),
    categoryIds: [],
  }, { timeout: 60000 });
  return { version: Number(data.versionNumber || 0), url: data.url || '', kernelId: data.kernelId || 0 };
}

export async function cancelSession(cfg, kernelSessionId) {
  if (!kernelSessionId) throw new KaggleError('No Kaggle session id to cancel');
  return call(cfg, SERVICE_KERNELS, 'CancelKernelSession', { kernelSessionId: Number(kernelSessionId) });
}

export async function userKernels(cfg) {
  const data = await call(cfg, SERVICE_KERNELS, 'ListKernels', { user: cfg.kaggleUser, pageSize: 50 });
  return (data.kernels || []).map((k) => ({ ref: k.ref, title: k.title, lastRun: k.lastRunTime }));
}

export async function validate(cfg) {
  const [q, ds] = await Promise.all([quota(cfg), datasetInfo(cfg).catch((err) => ({ exists: false, error: err.message }))]);
  return {
    kaggle: { ok: true, user: cfg.kaggleUser },
    quota: q,
    dataset: ds,
  };
}
