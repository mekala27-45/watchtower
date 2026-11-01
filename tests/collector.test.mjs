import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createSource, validateRepositoryIdentity, safeSourceLink, endpoint, validateEndpoint, cacheKey, planSource, collectSource, API_VERSION, MEDIA_TYPE, SOURCE_POLICY_VERSION } from '../packages/collector/index.mjs';
import { normalizeRelease, digest } from '../packages/domain/index.mjs';

const namespace = 'synthetic:collector';
const source = createSource('vitejs/vite', 257485422);
const NOW = '2026-11-01T12:00:00.000Z';
function release(id = 1, overrides = {}) {
  return { id, tag_name: `v${id}.0.0`, draft: false, prerelease: false, published_at: '2026-10-30T12:00:00Z', created_at: '2026-10-29T12:00:00Z', body: 'Original synthetic release text.', assets: [{ id: id * 10, name: 'fixture.zip', size: 15, content_type: 'application/zip' }], author: { login: 'DO_NOT_PERSIST' }, ...overrides };
}
const json = (body, headers = {}) => ({ status: 200, headers: { 'content-type': 'application/json; charset=utf-8', ...headers }, body });
function queue(...responses) {
  const calls = [];
  const transport = async request => { calls.push(request); const next = responses.shift(); if (next instanceof Error) throw next; assert.ok(next, 'Unexpected request'); return next; };
  return { transport, calls };
}
const collect = options => collectSource({ namespace, source, now: NOW, ...options });
const page2 = `<https://api.github.com/repos/vitejs/vite/releases?per_page=20&page=2>; rel="next"`;
const page3 = `<https://api.github.com/repos/vitejs/vite/releases?per_page=20&page=3>; rel="next"`;

test('source policy clean case admits only a pinned allowlisted repository', () => {
  assert.deepEqual(validateRepositoryIdentity(source, { id: source.sourceId, full_name: source.label }), source);
  assert.equal(validateEndpoint(source, endpoint(source, { page: 1 })), 'https://api.github.com/repos/vitejs/vite/releases?per_page=20&page=1');
  assert.equal(validateEndpoint(source, endpoint(source, { releaseId: 3 })), 'https://api.github.com/repos/vitejs/vite/releases/3');
});
test('source policy deliberate violations reject hosts, redirects scope, identities and URLs', () => {
  for (const url of ['https://evil.test/repos/vitejs/vite/releases?per_page=20&page=1', 'http://api.github.com/repos/vitejs/vite/releases/1', '//evil.test/x', '/repos/other/vite/releases/1', '/repos/vitejs/vite/releases/1?x=1', '/repos/vitejs/vite/releases/1#x', '/repos/vitejs/vite/releases?per_page=100&page=1', '/repos/vitejs/vite/releases?per_page=20&page=3']) assert.throws(() => validateEndpoint(source, url));
  assert.throws(() => createSource('other/repo', 1));
  assert.throws(() => createSource('vitejs/vite', -1));
  assert.throws(() => validateRepositoryIdentity(source, { id: source.sourceId + 1, full_name: source.label }), /SOURCE_IDENTITY_CONFLICT/);
  assert.throws(() => validateRepositoryIdentity(source, { id: source.sourceId, full_name: 'vitejs/renamed' }), /SOURCE_IDENTITY_CONFLICT/);
});
test('source policy empty input refuses', () => {
  assert.throws(() => createSource()); assert.throws(() => endpoint(source)); assert.throws(() => validateEndpoint(source, '')); assert.throws(() => validateRepositoryIdentity(source));
});
test('safe source links use validated fixed host and encoded captured tag only', () => {
  const evidence = normalizeRelease(release(1, { tag_name: 'feature/x?redirect=https://evil.test/#<script>', html_url: 'https://evil.test/raw' }), { namespace, sourceId: source.sourceId });
  const link = safeSourceLink(source, evidence);
  assert.equal(new URL(link).host, 'github.com');
  assert.ok(link.startsWith('https://github.com/vitejs/vite/releases/tag/feature%2Fx%3F'));
  assert.equal(new URL(link).search, ''); assert.equal(new URL(link).hash, '');
  assert.throws(() => safeSourceLink(createSource('vitejs/vite', 10), evidence), /SOURCE_EVIDENCE_MISMATCH/);
  assert.throws(() => safeSourceLink(source, { ...evidence, tag_name: 'tampered' }), /SOURCE_EVIDENCE_MISMATCH/);
  assert.throws(() => safeSourceLink(source));
  assert.equal(SOURCE_POLICY_VERSION, 'source-policy-v1');
});
test('cache key includes all scopes and never stores a credential', () => {
  const config = { namespace, source, path: endpoint(source, { page: 1 }) }; const base = cacheKey(config);
  for (const change of [{ namespace: 'synthetic:other' }, { source: createSource('vitejs/vite', 3) }, { path: endpoint(source, { page: 2 }) }, { apiVersion: '2022-11-28' }, { mediaType: 'application/json' }, { authScopeFingerprint: 'scope2' }, { normalizerVersion: '2' }]) assert.notEqual(cacheKey({ ...config, ...change }), base);
  assert.throws(() => cacheKey({ ...config, authScopeFingerprint: 'Bearer secret value' }));
});
test('planner selects approved IDs then newest prior identities with stable numeric ties', () => {
  const plan = planSource({ namespace, source, now: NOW, watchedIds: [9, 2], previousItems: [{ release_id: 5, observed_at: '2026-10-31Z' }, { release_id: 4, observed_at: '2026-10-31Z' }, { release_id: 1, observed_at: '2026-10-20Z' }] });
  assert.deepEqual(plan.requests.filter(x => x.type === 'item').map(x => x.releaseId), [2, 9, 4, 5]);
  assert.equal(plan.window.start, '2026-10-02T12:00:00.000Z');
  assert.equal(plan.requests.length, 6);
});
test('collection clean pass normalizes metadata only and declares bounded non-atomic coverage', async () => {
  const q = queue(json([release()], { etag: 'W/"opaque value"' })); const cache = new Map();
  const result = await collect({ ...q, cache });
  assert.equal(result.state, 'captured'); assert.equal(result.coverage.procedure_complete, true);
  assert.equal(result.coverage.atomic_snapshot, false); assert.equal(result.coverage.exhaustive_history, false);
  assert.equal(result.items.length, 1); assert.equal(result.attempts.length, 1);
  assert.equal(result.comparison_outcome, 'insufficient');
  assert.equal(q.calls[0].redirect, 'manual'); assert.equal(q.calls[0].headers['X-GitHub-Api-Version'], API_VERSION);
  assert.equal(q.calls[0].headers.Accept, MEDIA_TYPE);
  const persisted = JSON.stringify([...cache.values()]);
  assert.ok(!persisted.includes('DO_NOT_PERSIST')); assert.ok(!persisted.includes('Original synthetic release text'));
  assert.equal(result.items[0].notes_bytes, Buffer.byteLength(release().body));
});
test('collection valid empty 200 is captured empty scope and never a deletion or no-change claim', async () => {
  const result = await collect(queue(json([])));
  assert.equal(result.state, 'captured'); assert.deepEqual(result.items, []);
  assert.equal(result.comparison_outcome, 'insufficient');
  await assert.rejects(() => collectSource({}), /INVALID_REQUEST|SOURCE_NOT|INVALID_NAMESPACE/);
});
test('304 valid cache retains content timestamp and refreshes successful check time', async () => {
  const cache = new Map(); await collect({ ...queue(json([release()], { etag: 'W/"unaltered"' })), cache });
  const q = queue({ status: 304, headers: {}, body: '' });
  const result = await collectSource({ source, namespace, now: '2026-11-02T12:00:00.000Z', transport: q.transport, cache });
  assert.equal(result.state, 'captured'); assert.equal(result.attempts[0].cache_outcome, 'valid_304');
  assert.equal(q.calls[0].headers['If-None-Match'], 'W/"unaltered"');
  assert.equal(result.coverage.page_boundaries[0].captured_at, NOW);
  assert.equal([...cache.values()][0].checked_at, '2026-11-02T12:00:00.000Z');
});
test('304 missing cache performs one unconditional recovery within the shared attempt budget', async () => {
  const q = queue({ status: 304, headers: {}, body: '' }, json([release()]));
  const budget = { remaining: 2 }; const result = await collect({ ...q, budget });
  assert.equal(result.state, 'captured'); assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].error_code, 'MISSING_MATCHING_CACHE'); assert.equal(result.attempts[1].unconditional_recovery, true);
  assert.equal(q.calls[1].headers['If-None-Match'], undefined); assert.equal(budget.remaining, 0);
});
test('304 missing or corrupt cache without recovery remains unavailable and cannot become empty baseline', async () => {
  const q = queue({ status: 304, headers: {}, body: '' });
  const result = await collect({ ...q, budget: { remaining: 1 } });
  assert.equal(result.state, 'unavailable'); assert.equal(result.coverage.procedure_complete, false);
  const cache = new Map(); await collect({ ...queue(json([release()])), cache }); [...cache.values()][0].items.push({ forged: true });
  const corrupted = await collect({ ...queue({ status: 304, headers: {}, body: '' }), cache, budget: { remaining: 1 } });
  assert.equal(corrupted.state, 'unavailable'); assert.equal(corrupted.attempts[0].error_code, 'MISSING_MATCHING_CACHE');
});
test('expired cache and cross-namespace cache evidence are refused', async () => {
  const cache = new Map(); await collect({ ...queue(json([release()])), cache });
  const expired = await collectSource({ namespace, source, now: '2026-11-09T12:00:00.000Z', cache, budget: { remaining: 1 }, ...queue({ status: 304, headers: {}, body: '' }) });
  assert.equal(expired.state, 'unavailable'); assert.equal(expired.errors[0].code, 'MISSING_MATCHING_CACHE');
  const entry = [...cache.values()][0]; entry.items[0].namespace = 'synthetic:other';
  const wrongScope = await collect({ cache, budget: { remaining: 1 }, ...queue({ status: 304, headers: {}, body: '' }) });
  assert.equal(wrongScope.state, 'unavailable');
});
test('cache rejects a forged inner evidence digest even with a recomputed outer cache digest', async () => {
  const cache = new Map(); await collect({ ...queue(json([release()])), cache });
  const entry = [...cache.values()][0]; entry.items[0].tag_name = 'tampered'; entry.digest = digest(entry.items);
  const result = await collect({ cache, budget: { remaining: 1 }, ...queue({ status: 304, headers: {}, body: '' }) });
  assert.equal(result.state, 'unavailable'); assert.equal(result.errors[0].code, 'MISSING_MATCHING_CACHE');
});
test('page one valid and page two malformed retains positive evidence with partial coverage', async () => {
  const result = await collect(queue(json([release()], { link: page2 }), json('{')));
  assert.equal(result.state, 'partial'); assert.equal(result.items.length, 1);
  assert.equal(result.errors[0].code, 'INVALID_JSON'); assert.equal(result.coverage.procedure_complete, false);
});
test('a successfully observed empty first page followed by failure remains partial', async () => {
  const result = await collect(queue(json([], { link: page2 }), json('{')));
  assert.equal(result.state, 'partial'); assert.equal(result.items.length, 0);
  assert.equal(result.coverage.page_boundaries.length, 1); assert.equal(result.coverage.procedure_complete, false);
});
test('bounded pagination reports uncovered pages and refuses forged next links', async () => {
  const result = await collect(queue(json([release()], { link: page2 }), json([release(2)], { link: page3 })));
  assert.equal(result.state, 'partial'); assert.equal(result.coverage.truncated, true); assert.equal(result.attempts.length, 2);
  const forged = await collect(queue(json([release()], { link: '<https://evil.test/x>; rel="next"' })));
  assert.equal(forged.state, 'unavailable'); assert.equal(forged.errors[0].code, 'UNTRUSTED_NEXT_PAGE');
});
test('numeric GitHub pagination alias is pinned to the verified repository and never used as an outbound URL',async()=>{
  const next=`<https://api.github.com/repositories/${source.sourceId}/releases?per_page=20&page=2>; rel="next", <https://api.github.com/repositories/${source.sourceId}/releases?per_page=20&page=15>; rel="last"`;
  const q=queue(json([release()],{link:next}),json([release(2)]));
  const result=await collect(q);assert.equal(result.state,'captured');assert.equal(result.attempts.length,2);
  assert.equal(q.calls[1].url,`https://api.github.com/repos/${source.label}/releases?per_page=20&page=2`);
  const truncated=await collect(queue(json([release()],{link:next}),json([release(2)],{link:`<https://api.github.com/repositories/${source.sourceId}/releases?per_page=20&page=3>; rel="next"`})));
  assert.equal(truncated.state,'partial');assert.equal(truncated.coverage.truncated,true);assert.equal(truncated.attempts.length,2);
  for(const url of [
    `https://api.github.com/repositories/${source.sourceId+1}/releases?per_page=20&page=2`,
    `https://api.github.com/repositories/${source.sourceId}/releases?per_page=20&page=02`,
    `https://api.github.com/repositories/${source.sourceId}/releases?per_page=20&page=2&extra=1`,
    `https://api.github.com/repositories/${source.sourceId}/releases?per_page=20&page=2#forged`,
  ]){const rejected=await collect(queue(json([release()],{link:`<${url}>; rel="next"`})));assert.equal(rejected.state,'unavailable');assert.equal(rejected.errors[0].code,'UNTRUSTED_NEXT_PAGE');assert.equal(rejected.attempts.length,1);}
});
test('same duplicate identity is deduplicated and conflicting pages are unstable', async () => {
  const stable = await collect(queue(json([release()], { link: page2 }), json([release()])));
  assert.equal(stable.state, 'captured'); assert.equal(stable.items.length, 1);
  const moving = await collect(queue(json([release()], { link: page2 }), json([release(1, { tag_name: 'changed' })])));
  assert.equal(moving.state, 'unstable'); assert.equal(moving.coverage.procedure_complete, false);
});
test('timeout and 404 remain unavailable observations and never imply removal', async () => {
  const timeout = new Error('sensitive transport detail'); timeout.name = 'TimeoutError';
  const result = await collect(queue(timeout)); assert.equal(result.state, 'unavailable'); assert.equal(result.errors[0].code, 'REQUEST_TIMEOUT');
  assert.ok(!JSON.stringify(result).includes('sensitive transport detail'));
  const missing = await collect({ ...queue(json([release()]), { status: 404, headers: {}, body: '' }), watchedIds: [2] });
  assert.equal(missing.state, 'partial'); assert.equal(missing.coverage.rechecks[0].state, 'unavailable'); assert.equal(missing.items.length, 1);
});
test('transport deadline terminates even an injected transport that ignores its abort signal', async () => {
  const result = await collect({ transport: () => new Promise(() => {}), limits: { timeoutMs: 5 } });
  assert.equal(result.state, 'unavailable'); assert.equal(result.errors[0].code, 'REQUEST_TIMEOUT');
});
test('throttle records a future retry timestamp and stops without sleeping or another request', async () => {
  const q = queue({ status: 429, headers: { 'retry-after': '120', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1793534700' }, body: '' });
  const result = await collect(q);
  assert.equal(result.state, 'deferred'); assert.equal(q.calls.length, 1); assert.ok(Date.parse(result.next_eligible_at) >= Date.parse(NOW) + 120000);
});
test('request budget is shared and exhaustion cannot yield a complete procedure', async () => {
  const budget = { remaining: 1 }; const q = queue(json([release()], { link: page2 }));
  const result = await collect({ ...q, budget });
  assert.equal(result.state, 'partial'); assert.equal(result.errors[0].code, 'REQUEST_BUDGET_EXHAUSTED'); assert.equal(q.calls.length, 1);
  const later = await collect({ ...queue(), budget }); assert.equal(later.state, 'unavailable'); assert.equal(later.attempts.length, 0);
});
test('response gates reject redirect, media mismatch, oversize, malformed schema and empty input', async () => {
  const cases = [
    [{ status: 302, headers: { location: 'https://evil.test/' }, body: '' }, 'REDIRECT_REFUSED'],
    [{ status: 200, headers: { 'content-type': 'text/html' }, body: '<html>' }, 'UNEXPECTED_MEDIA_TYPE'],
    [json([release()], { 'content-length': '1048577' }), 'RESPONSE_TOO_LARGE'],
    [json('{}'), 'RESPONSE_SCHEMA_REFUSED'],
    [json(''), 'INVALID_JSON'],
    [json([release(1, { id: 'forged' })]), null]
  ];
  for (const [response, expected] of cases) {
    const result = await collect(queue(response)); assert.equal(result.state, 'unavailable');
    if (expected) assert.equal(result.errors[0].code, expected);
  }
});
test('size-capped response streams preserve valid evidence and reject streamed oversize', async () => {
  const body = JSON.stringify([release()]);
  const transport = async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  const valid = await collect({ transport }); assert.equal(valid.state, 'captured');
  const oversized = await collect({ transport, limits: { maxBytes: 32 } });
  assert.equal(oversized.state, 'unavailable'); assert.equal(oversized.errors[0].code, 'RESPONSE_TOO_LARGE');
});
test('a hanging body stream is bounded by the request timeout after headers return', async () => {
  let cancelled = false;
  const transport = async () => new Response(new ReadableStream({ start(controller) {}, cancel() { cancelled = true; } }), { status: 200, headers: { 'content-type': 'application/json' } });
  const result = await collect({ transport, limits: { timeoutMs: 10 } });
  assert.equal(result.state, 'unavailable'); assert.equal(result.errors[0].code, 'REQUEST_TIMEOUT');
  assert.equal(cancelled, true);
});
test('controlled HTTP transport exercises actual size-capped body stream and redirect refusal', async t => {
  const server = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: 'https://evil.test/' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify([release()]));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fetch(base); } catch (error) {
    if (error.cause?.code === 'EACCES') { t.skip('Host sandbox refuses loopback TCP with EACCES; actual controlled-server integration is not verified'); return; }
    throw error;
  }
  const transport = async request => { validateEndpoint(source, request.url); return fetch(base + '/', { redirect: request.redirect, signal: request.signal }); };
  const result = await collect({ transport }); assert.equal(result.state, 'captured'); assert.ok(result.attempts[0].response_bytes > 0);
  const oversized = await collect({ transport, limits: { maxBytes: 32 } }); assert.equal(oversized.errors[0].code, 'RESPONSE_TOO_LARGE');
  const redirected = await collect({ transport: request => fetch(base + '/redirect', { redirect: request.redirect, signal: request.signal }) });
  assert.equal(redirected.errors[0].code, 'REDIRECT_REFUSED');
});
