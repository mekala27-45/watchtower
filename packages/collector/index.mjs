import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { normalizeRelease, validateEvidence } from '../domain/index.mjs';

export const SOURCE_LABELS = Object.freeze(['vercel/eve', 'ollama/ollama', 'microsoft/playwright', 'vitejs/vite']);
export const API_VERSION = '2026-03-10';
export const MEDIA_TYPE = 'application/vnd.github+json';
export const NORMALIZER_VERSION = 'normalizer-v1';
export const SOURCE_POLICY_VERSION = 'source-policy-v1';
export const CACHE_TTL_MS = 7 * 86400000;
export const DEFAULT_LIMITS = Object.freeze({ pages: 2, perPage: 20, rechecks: 4, attempts: 24, maxBytes: 1048576, timeoutMs: 10000, deadlineMs: 45000 });

function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}
const sha = v => createHash('sha256').update(canonical(v)).digest('hex');
const positive = n => Number.isSafeInteger(n) && n > 0;
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function ns(value) { if (typeof value !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(value)) fail('INVALID_NAMESPACE'); return value; }
function clock(now) { const value = typeof now === 'function' ? now() : now ?? new Date(); const date = new Date(value); if (!Number.isFinite(+date)) fail('INVALID_CLOCK'); return date; }

export function createSource(label, sourceId) {
  if (!SOURCE_LABELS.includes(label) || !positive(sourceId)) fail('SOURCE_NOT_ALLOWLISTED');
  return Object.freeze({ label, sourceId, policyVersion: SOURCE_POLICY_VERSION });
}
export function validateRepositoryIdentity(source, response) {
  source = createSource(source?.label, source?.sourceId);
  if (!response || !positive(response.id) || typeof response.full_name !== 'string') fail('INVALID_REPOSITORY_IDENTITY');
  if (response.id !== source.sourceId || response.full_name.toLowerCase() !== source.label.toLowerCase()) fail('SOURCE_IDENTITY_CONFLICT');
  return source;
}
export function safeSourceLink(source, evidence) {
  source = createSource(source?.label, source?.sourceId);
  if (!validateEvidence(evidence) || evidence.source_id !== source.sourceId) fail('SOURCE_EVIDENCE_MISMATCH');
  if (evidence.tag_name === '.' || evidence.tag_name === '..') fail('UNSAFE_RELEASE_TAG_LINK');
  const tag = encodeURIComponent(evidence.tag_name).replace(/[!'()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
  const result = new URL(`https://github.com/${source.label}/releases/tag/${tag}`);
  if (result.origin !== 'https://github.com' || !result.pathname.startsWith(`/${source.label}/releases/tag/`) || result.search || result.hash) fail('SOURCE_LINK_REFUSED');
  return result.href;
}
export function endpoint(source, { page, releaseId } = {}) {
  source = createSource(source?.label, source?.sourceId);
  if ((page === undefined) === (releaseId === undefined)) fail('INVALID_ENDPOINT_SELECTOR');
  if (page !== undefined && (!positive(page) || page > DEFAULT_LIMITS.pages)) fail('PAGE_OUT_OF_SCOPE');
  if (releaseId !== undefined && !positive(releaseId)) fail('INVALID_RELEASE_ID');
  return page !== undefined ? `/repos/${source.label}/releases?per_page=20&page=${page}` : `/repos/${source.label}/releases/${releaseId}`;
}
export function validateEndpoint(source, urlOrPath) {
  source = createSource(source?.label, source?.sourceId);
  if (typeof urlOrPath !== 'string' || urlOrPath.length > 512) fail('INVALID_SOURCE_URL');
  let url;
  try { url = new URL(urlOrPath, 'https://api.github.com'); } catch { fail('INVALID_SOURCE_URL'); }
  if (url.origin !== 'https://api.github.com' || url.username || url.password || url.hash) fail('SOURCE_HOST_REFUSED');
  const prefix = `/repos/${source.label}/releases`;
  if (url.pathname === prefix) {
    if (url.searchParams.size !== 2 || url.searchParams.get('per_page') !== '20' || !['1', '2'].includes(url.searchParams.get('page'))) fail('SOURCE_QUERY_REFUSED');
    if (url.search !== `?per_page=20&page=${url.searchParams.get('page')}`) fail('SOURCE_QUERY_REFUSED');
  } else {
    const id = url.pathname.slice(prefix.length + 1);
    if (!url.pathname.startsWith(prefix + '/') || !/^[1-9]\d*$/.test(id) || !positive(Number(id)) || url.search) fail('SOURCE_PATH_REFUSED');
  }
  return url.href;
}
export function cacheKey({ source, path, namespace, authScopeFingerprint = 'public', apiVersion = API_VERSION, mediaType = MEDIA_TYPE, normalizerVersion = NORMALIZER_VERSION }) {
  validateEndpoint(source, path); ns(namespace);
  if (typeof authScopeFingerprint !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(authScopeFingerprint)) fail('INVALID_AUTH_SCOPE_FINGERPRINT');
  return sha({ namespace, sourceId: source.sourceId, path: new URL(path, 'https://api.github.com').pathname + new URL(path, 'https://api.github.com').search, apiVersion, mediaType, authScopeFingerprint, normalizerVersion });
}
export function planSource({ source, namespace, now, watchedIds = [], previousItems = [] }) {
  source = createSource(source?.label, source?.sourceId); ns(namespace);
  if (!Array.isArray(watchedIds) || !Array.isArray(previousItems) || watchedIds.some(id => !positive(id))) fail('INVALID_RECHECK_SCOPE');
  const checkedAt = clock(now).toISOString();
  const prior = previousItems.filter(x => positive(x.release_id ?? x.id)).map(x => ({ id: x.release_id ?? x.id, time: Date.parse(x.observed_at ?? '') || 0 }));
  prior.sort((a, b) => b.time - a.time || a.id - b.id);
  const selected = [...new Set([...watchedIds].sort((a, b) => a - b).concat(prior.map(x => x.id)))].slice(0, DEFAULT_LIMITS.rechecks);
  const plan = {
    namespace, source, procedure_version: 'bounded-github-v1', checked_at: checkedAt,
    window: { start: new Date(Date.parse(checkedAt) - 30 * 86400000).toISOString(), end: checkedAt, days: 30 },
    limits: DEFAULT_LIMITS, cache_ttl_ms: CACHE_TTL_MS,
    requests: [{ type: 'list', page: 1, path: endpoint(source, { page: 1 }) }, { type: 'list', page: 2, conditional: 'page_one_has_next', path: endpoint(source, { page: 2 }) }, ...selected.map(releaseId => ({ type: 'item', releaseId, path: endpoint(source, { releaseId }) }))]
  };
  return Object.freeze({ ...plan, digest: sha(plan) });
}
function header(headers, key) {
  if (typeof headers?.get === 'function') return headers.get(key);
  const found = Object.entries(headers ?? {}).find(([k]) => k.toLowerCase() === key.toLowerCase());
  return found ? String(found[1]) : null;
}
function safeNumericHeader(headers, key) { const value = header(headers, key); return value !== null && /^\d{1,16}$/.test(value) ? value : null; }
function nextPage(headers, source, currentPage) {
  const value = header(headers, 'link');
  if (!value) return false;
  if (value.length > 4096) fail('INVALID_LINK_HEADER');
  for (const part of value.split(',')) {
    if (!/rel\s*=\s*"next"/.test(part)) continue;
    const target = part.match(/<([^>]+)>/)?.[1];
    if (!target) fail('INVALID_LINK_HEADER');
    let url; try { url = new URL(target); } catch { fail('INVALID_LINK_HEADER'); }
    if (url.origin !== 'https://api.github.com' || url.pathname !== `/repos/${source.label}/releases` || url.username || url.password || url.hash || url.searchParams.size !== 2 || url.searchParams.get('per_page') !== '20' || Number(url.searchParams.get('page')) !== currentPage + 1) fail('UNTRUSTED_NEXT_PAGE');
    return true;
  }
  return false;
}
async function readBody(response, cap, signal) {
  const declared = Number(header(response.headers, 'content-length'));
  if (Number.isFinite(declared) && declared > cap) fail('RESPONSE_TOO_LARGE');
  if (response.body?.getReader) {
    const reader = response.body.getReader(); const chunks = []; let bytes = 0;
    const cancel = () => { reader.cancel().catch(() => {}); };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > cap) { await reader.cancel(); fail('RESPONSE_TOO_LARGE'); } chunks.push(Buffer.from(value)); }
    } finally { signal?.removeEventListener('abort', cancel); reader.releaseLock(); }
    const text = Buffer.concat(chunks).toString('utf8');
    try { return { data: JSON.parse(text), bytes }; } catch { fail('INVALID_JSON'); }
  }
  const text = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
  if (typeof text !== 'string') fail('EMPTY_RESPONSE');
  const bytes = Buffer.byteLength(text); if (bytes > cap) fail('RESPONSE_TOO_LARGE');
  try { return { data: JSON.parse(text), bytes }; } catch { fail('INVALID_JSON'); }
}
export async function nativeTransport(request) {
  return fetch(request.url, { method: 'GET', headers: request.headers, redirect: 'manual', signal: request.signal });
}
function retryAt(response, now) {
  const retry = header(response.headers, 'retry-after');
  let delay = retry !== null && /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry ?? '') - +now;
  if (!Number.isFinite(delay) || delay < 0) delay = 60000;
  const reset = Number(header(response.headers, 'x-ratelimit-reset')) * 1000;
  if (header(response.headers, 'x-ratelimit-remaining') === '0' && Number.isFinite(reset)) delay = Math.max(delay, reset - +now);
  const timestamp = +now + Math.max(delay, 1000);
  if (!Number.isFinite(timestamp) || Math.abs(timestamp) > 8640000000000000) fail('INVALID_RETRY_TIMESTAMP');
  return new Date(timestamp).toISOString();
}

export async function collectSource({ source, namespace, transport = nativeTransport, cache = new Map(), budget = { remaining: 24 }, now, watchedIds = [], previousItems = [], authScopeFingerprint = 'public', limits = {}, signal }) {
  const settings = { ...DEFAULT_LIMITS, ...limits };
  for (const key of ['pages', 'perPage', 'rechecks', 'attempts']) if (settings[key] !== DEFAULT_LIMITS[key]) fail('PROCEDURE_SCOPE_CHANGE_REQUIRES_VERSION');
  for (const key of ['maxBytes', 'timeoutMs', 'deadlineMs']) if (!positive(settings[key]) || settings[key] > DEFAULT_LIMITS[key]) fail('INVALID_LIMIT');
  if (!budget || !Number.isInteger(budget.remaining) || budget.remaining < 0 || budget.remaining > 24) fail('INVALID_REQUEST_BUDGET');
  if (typeof transport !== 'function' || typeof cache?.get !== 'function' || typeof cache?.set !== 'function') fail('INVALID_COLLECTOR_INPUT');
  const plan = planSource({ source, namespace, now, watchedIds, previousItems });
  const started = performance.now(); const attempts = []; const boundaries = []; const byId = new Map();
  const errors = []; const rechecks = []; let hasNext = false; let truncated = false; let state = 'captured'; let nextEligible = null;
  const scopedKey = path => cacheKey({ source, namespace, path, authScopeFingerprint });
  async function request(spec, recovery = false) {
    if (budget.remaining <= 0) return { ok: false, code: 'REQUEST_BUDGET_EXHAUSTED' };
    if (performance.now() - started >= settings.deadlineMs || signal?.aborted) return { ok: false, code: 'RUN_DEADLINE' };
    const key = scopedKey(spec.path); const entry = cache.get(key);
    const usable = entry?.key === key && entry.validation_state === 'valid' && entry.source_policy_version === SOURCE_POLICY_VERSION && Date.parse(entry.expires_at) > +clock(now) && Array.isArray(entry.items) && entry.items.every(item => validateEvidence(item) && item.namespace === namespace && item.source_id === source.sourceId && positive(item.release_id) && item.normalizer_version === NORMALIZER_VERSION) && entry.digest === sha(entry.items);
    const headers = { Accept: MEDIA_TYPE, 'X-GitHub-Api-Version': API_VERSION, 'User-Agent': 'watchtower-portfolio' };
    if (!recovery && usable && typeof entry.etag === 'string') headers['If-None-Match'] = entry.etag;
    const begin = clock(now); const startTick = performance.now(); budget.remaining -= 1;
    const attempt = { request_id: `${plan.digest.slice(0, 16)}:${attempts.length + 1}`, path: spec.path, started_at: begin.toISOString(), finished_at: null, status: null, error_code: null, consumed_budget: 24 - budget.remaining, response_bytes: null, duration_ms: null, unconditional_recovery: recovery, cache_key: key };
    attempts.push(attempt);
    let abortHandler; let hardTimer; let requestSignal;
    try {
      const timeout = AbortSignal.timeout(Math.floor(Math.min(settings.timeoutMs, Math.max(1, settings.deadlineMs - (performance.now() - started)))));
      requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const abort = new Promise((resolve, reject) => {
        abortHandler = () => reject(requestSignal.reason);
        requestSignal.addEventListener('abort', abortHandler, { once: true });
        hardTimer = setTimeout(() => { const error = new Error('REQUEST_TIMEOUT'); error.name = 'TimeoutError'; reject(error); }, Math.min(settings.timeoutMs, Math.max(1, settings.deadlineMs - (performance.now() - started))));
      });
      const response = await Promise.race([transport({ url: validateEndpoint(source, spec.path), headers, redirect: 'manual', signal: requestSignal, maxBytes: settings.maxBytes }), abort]);
      if (!response || !Number.isInteger(response.status)) fail('INVALID_RESPONSE');
      attempt.status = response.status;
      attempt.rate_limit = { remaining: safeNumericHeader(response.headers, 'x-ratelimit-remaining'), reset: safeNumericHeader(response.headers, 'x-ratelimit-reset'), retry_after_seconds: safeNumericHeader(response.headers, 'retry-after') };
      if (response.redirected || (response.status >= 300 && response.status < 400 && response.status !== 304)) fail('REDIRECT_REFUSED');
      if (response.status === 304) {
        attempt.response_bytes = 0;
        if (!usable) {
          attempt.error_code = 'MISSING_MATCHING_CACHE';
          if (!recovery && budget.remaining > 0) return await request(spec, true);
          return { ok: false, code: 'MISSING_MATCHING_CACHE' };
        }
        entry.checked_at = clock(now).toISOString(); entry.expires_at = new Date(+clock(now) + CACHE_TTL_MS).toISOString(); cache.set(key, entry); attempt.cache_outcome = 'valid_304';
        return { ok: true, items: entry.items, hasNext: entry.has_next, captured_at: entry.captured_at, cache_outcome: 'valid_304' };
      }
      if (response.status === 429 || (response.status === 403 && (header(response.headers, 'retry-after') !== null || header(response.headers, 'x-ratelimit-remaining') === '0'))) {
        nextEligible = retryAt(response, clock(now)); attempt.error_code = 'THROTTLED'; return { ok: false, code: 'THROTTLED', deferred: true };
      }
      if (response.status !== 200) { const code = response.status === 404 ? 'ITEM_UNAVAILABLE' : response.status >= 500 ? 'SOURCE_SERVER_ERROR' : 'SOURCE_REFUSED'; attempt.error_code = code; return { ok: false, code }; }
      const type = header(response.headers, 'content-type');
      if (!type || !/^(application\/json|application\/vnd\.github\+json)(\s*;|$)/i.test(type)) fail('UNEXPECTED_MEDIA_TYPE');
      const { data, bytes } = await Promise.race([readBody(response, settings.maxBytes, requestSignal), abort]); attempt.response_bytes = bytes;
      const raw = spec.type === 'list' ? data : [data];
      if (!Array.isArray(raw) || raw.length > 20 || (spec.type === 'item' && data?.id !== spec.releaseId)) fail('RESPONSE_SCHEMA_REFUSED');
      const items = raw.map(item => {
        try { return normalizeRelease(item, { namespace, sourceId: source.sourceId }); }
        catch { fail('RESPONSE_SCHEMA_REFUSED'); }
      });
      const more = spec.type === 'list' ? nextPage(response.headers, source, spec.page) : false;
      const capturedAt = clock(now).toISOString();
      const etag = header(response.headers, 'etag');
      if (etag !== null && (etag.length > 512 || /[\r\n\0]/.test(etag))) fail('INVALID_CACHE_VALIDATOR');
      const stored = { key, items, digest: sha(items), etag, captured_at: capturedAt, checked_at: capturedAt, expires_at: new Date(+clock(now) + CACHE_TTL_MS).toISOString(), source_policy_version: SOURCE_POLICY_VERSION, validation_state: 'valid', has_next: more };
      cache.set(key, stored); attempt.cache_outcome = 'captured_200';
      return { ok: true, items, hasNext: more, captured_at: capturedAt, cache_outcome: 'captured_200' };
    } catch (error) {
      const code = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'REQUEST_TIMEOUT' : error?.code && /^[A-Z_]+$/.test(error.code) ? error.code : 'TRANSPORT_FAILURE';
      attempt.error_code = code; return { ok: false, code };
    } finally {
      clearTimeout(hardTimer); requestSignal?.removeEventListener('abort', abortHandler);
      attempt.finished_at = clock(now).toISOString(); attempt.duration_ms = Math.max(0, performance.now() - startTick);
    }
  }
  for (const spec of plan.requests) {
    if (spec.page === 2 && !hasNext) continue;
    const result = await request(spec);
    if (!result.ok) {
      errors.push({ path: spec.path, code: result.code });
      if (spec.type === 'item') rechecks.push({ release_id: spec.releaseId, state: 'unavailable', code: result.code });
      state = result.deferred ? 'deferred' : boundaries.length > 0 || rechecks.some(check => check.state === 'captured') ? 'partial' : 'unavailable';
      break;
    }
    if (spec.type === 'list') {
      hasNext = result.hasNext;
      boundaries.push({ page: spec.page, identities: result.items.map(i => i.release_id), has_next: hasNext, captured_at: result.captured_at, cache_outcome: result.cache_outcome });
      if (spec.page === 2 && hasNext) { truncated = true; state = 'partial'; }
    } else rechecks.push({ release_id: spec.releaseId, state: 'captured', captured_at: result.captured_at });
    for (const item of result.items) {
      const previous = byId.get(item.release_id);
      if (previous && previous.digest !== item.digest) { state = 'unstable'; errors.push({ path: spec.path, code: 'CONFLICTING_DUPLICATE_IDENTITY', release_id: item.release_id }); }
      if (!previous) byId.set(item.release_id, item);
    }
    if (state === 'unstable') break;
  }
  const items = [...byId.values()].sort((a, b) => a.release_id - b.release_id);
  return {
    namespace, mode: namespace === 'live' || namespace.startsWith('live:') ? 'live_source' : 'synthetic', source_id: source.sourceId, source_label: source.label,
    state, comparison_outcome: 'insufficient', plan, items, attempts, errors,
    checked_at: clock(now).toISOString(), next_eligible_at: nextEligible,
    active_duration_ms: Math.max(0, performance.now() - started), budget_remaining: budget.remaining,
    coverage: { window: plan.window, procedure_version: plan.procedure_version, procedure_complete: state === 'captured', atomic_snapshot: false, exhaustive_history: false, page_boundaries: boundaries, rechecks, observed_identity_count: items.length, truncated, uncovered_scope: truncated ? 'Additional pages beyond the registered page budget' : state === 'captured' ? 'History outside the declared bounded procedure' : 'Incomplete or unstable declared procedure', limitations: ['Metadata observations do not prove deletion or upgrade safety', 'Undetected pagination movement remains possible'] }
  };
}
