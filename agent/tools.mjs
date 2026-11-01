import { createHash, createHmac, randomBytes } from 'node:crypto';

export const TOOL_NAMES = Object.freeze(['list_changes', 'inspect_snapshot', 'propose_finding']);
export const FINDING_FIELDS = Object.freeze({
  newly_observed_release: 'identity',
  tag_changed: 'tag_name',
  prerelease_flag_changed: 'prerelease',
  asset_metadata_changed: 'assets',
  notes_text_changed: 'notes_digest',
});
const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
};
const hash = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const clone = value => structuredClone(value);
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const token = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const strict = (args, keys, required) => {
  if (!record(args) || Object.keys(args).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(args, key))) fail('invalid_arguments');
};
const deepFreeze = value => {
  if (value && typeof value === 'object') { Object.freeze(value); for (const item of Object.values(value)) deepFreeze(item); }
  return value;
};

export function assertToolInventory(names) {
  if (!Array.isArray(names) || names.length !== TOOL_NAMES.length ||
      new Set(names).size !== TOOL_NAMES.length || TOOL_NAMES.some(name => !names.includes(name))) fail('tool_inventory_mismatch');
  return true;
}

/**
 * This is a tested domain handler boundary, not an eve runtime proof.
 * invokeTest produces contract_test events. The execution path for an actual
 * model must independently prove provider origin before using these handlers.
 */
export function createToolSession(inputBundle, options = {}) {
  if (!record(inputBundle) || !token(inputBundle.id) || !token(inputBundle.namespace) ||
      !Array.isArray(inputBundle.candidates) || !record(inputBundle.evidence)) fail('invalid_bundle');
  const limits = { maxCalls: 4, maxInputBytes: 4096, maxOutputBytes: 32768, pageSize: 8, ...options.limits };
  if (!Number.isSafeInteger(limits.maxCalls) || limits.maxCalls < 1 || limits.maxCalls > 4 ||
      !Number.isSafeInteger(limits.pageSize) || limits.pageSize < 1 || limits.pageSize > 8 ||
      !Number.isSafeInteger(limits.maxInputBytes) || limits.maxInputBytes < 1 || limits.maxInputBytes > 4096 ||
      !Number.isSafeInteger(limits.maxOutputBytes) || limits.maxOutputBytes < 64 || limits.maxOutputBytes > 32768) fail('invalid_limits');
  if (inputBundle.candidates.length > 80 || Object.keys(inputBundle.evidence).length > 160 || bytes(inputBundle) > 262144) fail('bundle_too_large');
  const payload = clone(inputBundle);
  delete payload.id;
  delete payload.digest;
  if (!/^[a-f0-9]{64}$/.test(inputBundle.digest ?? '') || hash(payload) !== inputBundle.digest) fail('bundle_digest_mismatch');
  const bundle = deepFreeze(clone(inputBundle));
  const candidates = new Map();
  for (const candidate of bundle.candidates) {
    if (!record(candidate) || !token(candidate.id) || candidate.namespace !== bundle.namespace || candidates.has(candidate.id) ||
        !Number.isSafeInteger(candidate.source_id) || candidate.source_id < 1 || candidate.source_id !== bundle.source_id ||
        !Number.isSafeInteger(candidate.release_id) || candidate.release_id < 1 ||
        !Object.hasOwn(FINDING_FIELDS, candidate.kind) || candidate.field !== FINDING_FIELDS[candidate.kind]) fail('invalid_candidate_scope');
    candidates.set(candidate.id, candidate);
    for (const id of [candidate.before_evidence_id, candidate.after_evidence_id].filter(Boolean)) {
      const ev = bundle.evidence[id];
      if (!ev || ev.namespace !== bundle.namespace || ev.source_id !== candidate.source_id || ev.release_id !== candidate.release_id) fail('invalid_evidence_scope');
    }
  }
  const cursors = new Map();
  // Trusted runtime may persist this per-session seed to restore cursor bindings.
  // It is never accepted in model tool arguments; ordinary contract sessions use a fresh seed.
  const cursorSeed = options.cursorSeed ?? randomBytes(32).toString('hex');
  if (!/^[a-f0-9]{64}$/.test(cursorSeed)) fail('invalid_cursor_seed');
  const events = [];
  const proposals = [];
  let calls = 0;
  const inventoryDigest = hash(TOOL_NAMES);
  const snapshotFields = [
    'id', 'digest', 'namespace', 'source_id', 'release_id', 'tag', 'tag_name',
    'draft', 'prerelease', 'published_at', 'created_at', 'observed_at',
    'assets', 'body_digest', 'body_bytes', 'notes_digest', 'notes_bytes',
    'normalizer_version', 'coverage', 'source_url', 'metadata_digest',
  ];
  const handlers = {
    list_changes(args) {
      strict(args, ['bundle_id', 'cursor'], ['bundle_id']);
      if (args.bundle_id !== bundle.id) fail('bundle_scope_mismatch');
      let offset = 0;
      if (args.cursor !== undefined && args.cursor !== null) {
        if (!token(args.cursor) || !cursors.has(args.cursor)) fail('invalid_cursor');
        offset = cursors.get(args.cursor);
      }
      const page = bundle.candidates.slice(offset, offset + limits.pageSize).map(c => ({
        candidate_id: c.id, source_id: c.source_id, release_id: c.release_id,
        permitted_kinds: [c.kind], field: c.field,
      }));
      let next = null;
      if (offset + limits.pageSize < bundle.candidates.length) {
        next = createHmac('sha256', cursorSeed).update(bundle.id + ':' + (offset + limits.pageSize)).digest('base64url');
        cursors.set(next, offset + limits.pageSize);
      }
      return { namespace: bundle.namespace, bundle_id: bundle.id, candidates: page, next_cursor: next, coverage: clone(bundle.after?.state ?? 'unknown') };
    },
    inspect_snapshot(args) {
      strict(args, ['candidate_id', 'revision'], ['candidate_id', 'revision']);
      const candidate = candidates.get(args.candidate_id);
      if (!candidate) fail('candidate_scope_mismatch');
      if (!['before', 'after'].includes(args.revision)) fail('invalid_revision');
      const id = candidate[args.revision + '_evidence_id'];
      if (!id || !bundle.evidence[id]) fail('snapshot_unavailable');
      const evidence = bundle.evidence[id];
      const result = Object.fromEntries(snapshotFields.filter(k => Object.hasOwn(evidence, k)).map(k => [k, clone(evidence[k])]));
      return { namespace: bundle.namespace, evidence_id: id, evidence: result, coverage: clone(bundle[args.revision]?.state ?? 'unknown'), source_fields_are_untrusted: true };
    },
    propose_finding(args) {
      const keys = ['candidate_id', 'kind', 'field', 'before_evidence_id', 'after_evidence_id'];
      strict(args, keys, ['candidate_id', 'kind', 'field', 'after_evidence_id']);
      const candidate = candidates.get(args.candidate_id);
      if (!candidate) fail('candidate_scope_mismatch');
      if (!Object.hasOwn(FINDING_FIELDS, args.kind) || typeof args.field !== 'string' || args.field.length > 64) fail('invalid_finding_schema');
      if (args.kind !== candidate.kind || args.field !== candidate.field) fail('candidate_predicate_mismatch');
      if (args.after_evidence_id !== candidate.after_evidence_id ||
          (args.before_evidence_id ?? null) !== (candidate.before_evidence_id ?? null)) fail('evidence_scope_mismatch');
      if (args.kind !== 'newly_observed_release' && !args.before_evidence_id) fail('before_evidence_required');
      const payload = { ...clone(args), before_evidence_id: args.before_evidence_id ?? null, method: 'local_agent' };
      const proposal = {
        payload,
        namespace: bundle.namespace, method: 'local_agent', execution_mode: 'contract_test', model_requested: false,
        bundle_digest: bundle.digest, approval_status: 'unapproved',
      };
      proposal.id = 'proposal-' + hash(proposal);
      return { proposal, effect: 'append_unapproved_proposal' };
    },
  };
  function invokeTest(name, args) {
    const started = performance.now();
    const event = { sequence: calls + 1, tool: name, origin: 'contract_test', model_requested: false, handler_executed: false };
    calls += 1;
    try {
      if (!TOOL_NAMES.includes(name)) fail('tool_not_permitted');
      if (calls > limits.maxCalls) fail('tool_budget_exhausted');
      if (bytes(args) > limits.maxInputBytes) fail('input_too_large');
      event.arguments_digest = hash(args);
      const result = handlers[name](args);
      if (bytes(result) > limits.maxOutputBytes) fail('output_too_large');
      event.handler_executed = true;
      event.status = 'completed';
      event.result_digest = hash(result);
      if (result.proposal) proposals.push(deepFreeze(clone(result.proposal)));
      return clone(result);
    } catch (error) {
      event.status = 'rejected';
      event.error_code = error.code ?? 'invalid_arguments';
      return { error: event.error_code, namespace: bundle.namespace };
    } finally {
      event.elapsed_ms = performance.now() - started;
      events.push(deepFreeze(event));
    }
  }
  return Object.freeze({
    inventory: TOOL_NAMES, inventoryDigest, bundleDigest: bundle.digest,
    invokeTest,
    get trace() { return clone(events); },
    get proposals() { return clone(proposals); },
  });
}

