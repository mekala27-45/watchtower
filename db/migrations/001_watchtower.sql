-- Prepared PostgreSQL target. This migration has not been executed against Neon.
-- Local SQLite evidence does not validate PostgreSQL behavior.
BEGIN;
CREATE SCHEMA IF NOT EXISTS watchtower;
SET LOCAL search_path = watchtower, pg_catalog;

CREATE DOMAIN sha256_hex AS text CHECK (VALUE ~ '^[0-9a-f]{64}$');
CREATE DOMAIN method_name AS text CHECK (VALUE IN
  ('deterministic_baseline', 'local_agent', 'recorded_local_agent'));

CREATE TABLE namespaces (
  namespace text PRIMARY KEY CHECK (length(namespace) BETWEEN 1 AND 128),
  kind text NOT NULL CHECK (kind IN ('live', 'synthetic_demo', 'evaluation')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE watchlists (
  namespace text NOT NULL REFERENCES namespaces(namespace),
  id text NOT NULL,
  current_version integer NOT NULL CHECK (current_version > 0),
  normalizer_version text NOT NULL,
  verifier_version text NOT NULL,
  PRIMARY KEY (namespace, id)
);
CREATE TABLE watchlist_versions (
  namespace text NOT NULL,
  watchlist_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  configuration jsonb NOT NULL CHECK (jsonb_typeof(configuration) = 'object'),
  configuration_digest sha256_hex NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace, watchlist_id, version),
  FOREIGN KEY (namespace, watchlist_id) REFERENCES watchlists(namespace, id)
    DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE watchlists ADD CONSTRAINT watchlists_current_version_fk
  FOREIGN KEY (namespace, id, current_version)
  REFERENCES watchlist_versions(namespace, watchlist_id, version)
  DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE sources (
  namespace text NOT NULL REFERENCES namespaces(namespace),
  source_id bigint NOT NULL CHECK (source_id > 0),
  repository_label text NOT NULL CHECK (repository_label IN
    ('vercel/eve', 'ollama/ollama', 'microsoft/playwright', 'vitejs/vite')),
  policy_version text NOT NULL,
  PRIMARY KEY (namespace, source_id),
  UNIQUE (namespace, repository_label)
);
CREATE TABLE source_leases (
  namespace text NOT NULL,
  source_id bigint NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  owner_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (namespace, source_id),
  FOREIGN KEY (namespace, source_id) REFERENCES sources(namespace, source_id)
);
CREATE TABLE collection_runs (
  namespace text NOT NULL,
  id text NOT NULL,
  watchlist_id text NOT NULL,
  watchlist_version integer NOT NULL,
  run_key text NOT NULL,
  plan_digest sha256_hex NOT NULL,
  state text NOT NULL CHECK (state IN
    ('planned', 'collecting', 'deferred', 'captured', 'partial', 'unavailable', 'unstable')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  next_eligible_at timestamptz,
  attempt_budget integer NOT NULL CHECK (attempt_budget BETWEEN 1 AND 24),
  PRIMARY KEY (namespace, id),
  UNIQUE (namespace, run_key),
  FOREIGN KEY (namespace, watchlist_id, watchlist_version)
    REFERENCES watchlist_versions(namespace, watchlist_id, version)
);
CREATE TABLE request_attempts (
  namespace text NOT NULL,
  id text NOT NULL,
  run_id text NOT NULL,
  source_id bigint NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 24),
  request_digest sha256_hex NOT NULL,
  safe_path text NOT NULL CHECK (safe_path LIKE '/repos/%'),
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  status integer CHECK (status BETWEEN 100 AND 599),
  safe_error_code text,
  response_bytes bigint NOT NULL CHECK (response_bytes >= 0),
  active_duration_ms double precision NOT NULL CHECK (active_duration_ms >= 0),
  rate_limit_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (namespace, id),
  UNIQUE (namespace, run_id, ordinal),
  FOREIGN KEY (namespace, run_id) REFERENCES collection_runs(namespace, id),
  FOREIGN KEY (namespace, source_id) REFERENCES sources(namespace, source_id),
  CHECK (finished_at >= started_at)
);
CREATE TABLE observations (
  namespace text NOT NULL,
  id text NOT NULL,
  source_id bigint NOT NULL,
  run_id text NOT NULL,
  digest sha256_hex NOT NULL,
  state text NOT NULL CHECK (state IN ('captured', 'partial', 'unavailable', 'unstable')),
  coverage jsonb NOT NULL CHECK (jsonb_typeof(coverage) = 'object'),
  checked_at timestamptz NOT NULL,
  content_captured_at timestamptz,
  procedure_version text NOT NULL,
  lease_generation bigint NOT NULL CHECK (lease_generation > 0),
  PRIMARY KEY (namespace, id),
  UNIQUE (namespace, source_id, digest),
  UNIQUE (namespace, source_id, id),
  FOREIGN KEY (namespace, source_id) REFERENCES sources(namespace, source_id),
  FOREIGN KEY (namespace, run_id) REFERENCES collection_runs(namespace, id)
);
CREATE TABLE evidence_revisions (
  namespace text NOT NULL,
  id text NOT NULL,
  source_id bigint NOT NULL,
  release_id bigint NOT NULL CHECK (release_id > 0),
  digest sha256_hex NOT NULL,
  normalizer_version text NOT NULL,
  metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata) = 'object'),
  captured_at timestamptz NOT NULL,
  byte_count bigint NOT NULL CHECK (byte_count >= 0),
  PRIMARY KEY (namespace, id),
  UNIQUE (namespace, source_id, release_id, digest),
  UNIQUE (namespace, source_id, id),
  FOREIGN KEY (namespace, source_id) REFERENCES sources(namespace, source_id),
  CHECK (NOT (metadata ?| ARRAY['body', 'author', 'login', 'avatar_url']))
);
CREATE TABLE observation_evidence (
  namespace text NOT NULL,
  observation_id text NOT NULL,
  evidence_id text NOT NULL,
  PRIMARY KEY (namespace, observation_id, evidence_id),
  FOREIGN KEY (namespace, observation_id) REFERENCES observations(namespace, id),
  FOREIGN KEY (namespace, evidence_id) REFERENCES evidence_revisions(namespace, id)
);
CREATE TABLE source_heads (
  namespace text NOT NULL,
  source_id bigint NOT NULL,
  latest_attempt_id text,
  comparison_head_id text,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  PRIMARY KEY (namespace, source_id),
  FOREIGN KEY (namespace, source_id) REFERENCES sources(namespace, source_id),
  FOREIGN KEY (namespace, source_id, latest_attempt_id) REFERENCES observations(namespace, source_id, id),
  FOREIGN KEY (namespace, source_id, comparison_head_id) REFERENCES observations(namespace, source_id, id)
);
CREATE TABLE cache_entries (
  namespace text NOT NULL,
  cache_key sha256_hex NOT NULL,
  source_id bigint NOT NULL,
  exact_path_query text NOT NULL,
  media_type text NOT NULL,
  api_version text NOT NULL,
  authentication_scope_fingerprint sha256_hex NOT NULL,
  normalizer_version text NOT NULL,
  validator text NOT NULL,
  observation_id text NOT NULL,
  content_digest sha256_hex NOT NULL,
  policy_version text NOT NULL,
  captured_at timestamptz NOT NULL,
  checked_at timestamptz NOT NULL,
  valid boolean NOT NULL,
  PRIMARY KEY (namespace, cache_key),
  FOREIGN KEY (namespace, source_id) REFERENCES sources(namespace, source_id),
  FOREIGN KEY (namespace, observation_id) REFERENCES observations(namespace, id),
  UNIQUE (namespace, source_id, exact_path_query, media_type, api_version,
    authentication_scope_fingerprint, normalizer_version)
);
CREATE TABLE candidate_changes (
  namespace text NOT NULL,
  id text NOT NULL,
  source_id bigint NOT NULL,
  release_id bigint NOT NULL CHECK (release_id > 0),
  before_evidence_id text,
  after_evidence_id text NOT NULL,
  finding_kind text NOT NULL CHECK (finding_kind IN
    ('newly_observed_release', 'tag_changed', 'prerelease_flag_changed',
     'asset_metadata_changed', 'notes_text_changed')),
  deduplication_digest sha256_hex NOT NULL,
  PRIMARY KEY (namespace, id),
  UNIQUE (namespace, deduplication_digest),
  FOREIGN KEY (namespace, source_id) REFERENCES sources(namespace, source_id),
  FOREIGN KEY (namespace, source_id, before_evidence_id) REFERENCES evidence_revisions(namespace, source_id, id),
  FOREIGN KEY (namespace, source_id, after_evidence_id) REFERENCES evidence_revisions(namespace, source_id, id)
);
CREATE TABLE evidence_bundles (
  namespace text NOT NULL,
  id text NOT NULL,
  digest sha256_hex NOT NULL,
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace, id),
  UNIQUE (namespace, digest)
);
CREATE TABLE bundle_candidates (
  namespace text NOT NULL,
  bundle_id text NOT NULL,
  candidate_id text NOT NULL,
  PRIMARY KEY (namespace, bundle_id, candidate_id),
  FOREIGN KEY (namespace, bundle_id) REFERENCES evidence_bundles(namespace, id),
  FOREIGN KEY (namespace, candidate_id) REFERENCES candidate_changes(namespace, id)
);
CREATE TABLE agent_runs (
  namespace text NOT NULL,
  id text NOT NULL,
  bundle_id text NOT NULL,
  method method_name NOT NULL,
  plan_digest sha256_hex NOT NULL,
  provenance jsonb NOT NULL,
  state text NOT NULL CHECK (state IN
    ('planned', 'running', 'completed', 'abstained', 'failed', 'timeout', 'unexecuted')),
  started_at timestamptz,
  finished_at timestamptz,
  PRIMARY KEY (namespace, id),
  FOREIGN KEY (namespace, bundle_id) REFERENCES evidence_bundles(namespace, id)
);
CREATE TABLE tool_events (
  namespace text NOT NULL,
  id text NOT NULL,
  agent_run_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 4),
  tool_name text NOT NULL CHECK (tool_name IN
    ('list_changes', 'inspect_snapshot', 'propose_finding')),
  model_requested boolean NOT NULL,
  handler_executed boolean NOT NULL,
  arguments_digest sha256_hex NOT NULL,
  result_digest sha256_hex,
  safe_error_code text,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace, id),
  UNIQUE (namespace, agent_run_id, ordinal),
  FOREIGN KEY (namespace, agent_run_id) REFERENCES agent_runs(namespace, id)
);
CREATE TABLE proposals (
  namespace text NOT NULL,
  id text NOT NULL,
  candidate_id text NOT NULL,
  agent_run_id text,
  method method_name NOT NULL,
  proposal_digest sha256_hex NOT NULL,
  typed_payload jsonb NOT NULL CHECK (jsonb_typeof(typed_payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace, id),
  FOREIGN KEY (namespace, candidate_id) REFERENCES candidate_changes(namespace, id),
  FOREIGN KEY (namespace, agent_run_id) REFERENCES agent_runs(namespace, id),
  CHECK (NOT (typed_payload ?| ARRAY['approved', 'verified', 'safe', 'complete', 'headline']))
);
CREATE TABLE verification_decisions (
  namespace text NOT NULL,
  id text NOT NULL,
  proposal_id text NOT NULL,
  bundle_id text NOT NULL,
  verifier_version text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('supported', 'unsupported', 'insufficient')),
  predicate text NOT NULL,
  operands jsonb NOT NULL,
  reason_code text NOT NULL,
  execution_receipt sha256_hex NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace, id),
  FOREIGN KEY (namespace, proposal_id) REFERENCES proposals(namespace, id),
  FOREIGN KEY (namespace, bundle_id) REFERENCES evidence_bundles(namespace, id)
);
CREATE TABLE briefing_revisions (
  namespace text NOT NULL,
  digest sha256_hex NOT NULL,
  payload_digest sha256_hex NOT NULL,
  watchlist_id text NOT NULL,
  watchlist_version integer NOT NULL,
  normalizer_version text NOT NULL,
  verifier_version text NOT NULL,
  method method_name NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  coverage_warning_digest sha256_hex NOT NULL,
  retention_requirements jsonb NOT NULL,
  prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace, digest),
  FOREIGN KEY (namespace, watchlist_id, watchlist_version)
    REFERENCES watchlist_versions(namespace, watchlist_id, version)
);
CREATE TABLE briefing_evidence (
  namespace text NOT NULL,
  briefing_digest sha256_hex NOT NULL,
  evidence_id text NOT NULL,
  PRIMARY KEY (namespace, briefing_digest, evidence_id),
  FOREIGN KEY (namespace, briefing_digest) REFERENCES briefing_revisions(namespace, digest),
  FOREIGN KEY (namespace, evidence_id) REFERENCES evidence_revisions(namespace, id)
);
CREATE TABLE briefing_source_dependencies (
  namespace text NOT NULL,
  briefing_digest sha256_hex NOT NULL,
  source_id bigint NOT NULL,
  expected_head_id text NOT NULL,
  expected_head_version bigint NOT NULL,
  PRIMARY KEY (namespace, briefing_digest, source_id),
  FOREIGN KEY (namespace, briefing_digest) REFERENCES briefing_revisions(namespace, digest),
  FOREIGN KEY (namespace, source_id) REFERENCES source_heads(namespace, source_id),
  FOREIGN KEY (namespace, expected_head_id) REFERENCES observations(namespace, id)
);
CREATE TABLE approvals (
  namespace text NOT NULL,
  id text NOT NULL,
  briefing_digest sha256_hex NOT NULL,
  reviewer_scope text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected', 'review_required')),
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (namespace, id),
  FOREIGN KEY (namespace, briefing_digest) REFERENCES briefing_revisions(namespace, digest),
  CHECK (expires_at > approved_at)
);
CREATE TABLE publications (
  namespace text NOT NULL,
  id text NOT NULL,
  briefing_digest sha256_hex NOT NULL,
  payload_digest sha256_hex NOT NULL,
  approval_id text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace, id),
  UNIQUE (namespace, briefing_digest, payload_digest),
  FOREIGN KEY (namespace, briefing_digest) REFERENCES briefing_revisions(namespace, digest),
  FOREIGN KEY (namespace, approval_id) REFERENCES approvals(namespace, id)
);
CREATE TABLE publication_receipts (
  namespace text NOT NULL,
  id text NOT NULL,
  publication_id text NOT NULL,
  receipt_digest sha256_hex NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace, id),
  UNIQUE (namespace, publication_id),
  FOREIGN KEY (namespace, publication_id) REFERENCES publications(namespace, id)
);
CREATE TABLE workflow_events (
  namespace text NOT NULL REFERENCES namespaces(namespace),
  id bigint GENERATED ALWAYS AS IDENTITY,
  event_kind text NOT NULL,
  object_id text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace, id)
);
CREATE TABLE idempotency_records (
  namespace text NOT NULL,
  operation_key text NOT NULL CHECK (length(operation_key) BETWEEN 1 AND 256),
  briefing_digest sha256_hex NOT NULL,
  payload_digest sha256_hex NOT NULL,
  receipt_id text NOT NULL,
  PRIMARY KEY (namespace, operation_key),
  FOREIGN KEY (namespace, briefing_digest) REFERENCES briefing_revisions(namespace, digest),
  FOREIGN KEY (namespace, receipt_id) REFERENCES publication_receipts(namespace, id)
);
CREATE TABLE demo_sessions (
  namespace text NOT NULL REFERENCES namespaces(namespace),
  id text NOT NULL,
  capability_digest sha256_hex NOT NULL,
  expires_at timestamptz NOT NULL,
  mutation_count integer NOT NULL DEFAULT 0 CHECK (mutation_count >= 0),
  mutation_limit integer NOT NULL CHECK (mutation_limit BETWEEN 1 AND 100),
  PRIMARY KEY (namespace, id),
  UNIQUE (namespace, capability_digest),
  CHECK (mutation_count <= mutation_limit)
);

CREATE INDEX evidence_item_history ON evidence_revisions
  (namespace, source_id, release_id, captured_at DESC);
CREATE INDEX attempt_run_history ON request_attempts (namespace, run_id, ordinal);
CREATE INDEX observations_source_history ON observations (namespace, source_id, checked_at DESC);
CREATE INDEX event_history ON workflow_events (namespace, occurred_at, id);

CREATE FUNCTION reject_immutable_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = watchtower, pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'immutable_record' USING ERRCODE = '55000';
END;
$$;
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'watchlist_versions', 'request_attempts', 'observations', 'evidence_revisions',
    'observation_evidence', 'candidate_changes', 'evidence_bundles', 'bundle_candidates',
    'tool_events', 'proposals', 'verification_decisions', 'briefing_revisions',
    'briefing_evidence', 'briefing_source_dependencies', 'approvals', 'publications',
    'publication_receipts', 'workflow_events', 'idempotency_records'
  ] LOOP
    EXECUTE format('CREATE TRIGGER immutable_update BEFORE UPDATE ON watchtower.%I '
      'FOR EACH ROW EXECUTE FUNCTION watchtower.reject_immutable_update()', table_name);
  END LOOP;
END;
$$;

-- Caller supplies checked canonical digests and scoped reviewer identity.
-- Function is SECURITY INVOKER. It never grants anonymous live publication.
-- This routine is a prepared target and still requires PostgreSQL integration tests.
CREATE FUNCTION publish_briefing(
  p_namespace text, p_operation_key text, p_briefing_digest sha256_hex,
  p_payload_digest sha256_hex, p_approval_id text, p_reviewer_scope text,
  p_publication_id text, p_receipt_id text, p_receipt_digest sha256_hex
) RETURNS TABLE (receipt_id text, recovered boolean)
LANGUAGE plpgsql SET search_path = watchtower, pg_catalog AS $$
DECLARE
  prior idempotency_records%ROWTYPE;
  briefing briefing_revisions%ROWTYPE;
  approval approvals%ROWTYPE;
  current_watchlist watchlists%ROWTYPE;
  dependency record;
  current_head source_heads%ROWTYPE;
  prior_receipt text;
BEGIN
  IF p_namespace IS NULL OR p_namespace = '' OR p_operation_key IS NULL OR p_operation_key = ''
      OR p_briefing_digest IS NULL OR p_payload_digest IS NULL OR p_approval_id IS NULL
      OR p_reviewer_scope IS NULL OR p_reviewer_scope = '' OR p_publication_id IS NULL
      OR p_receipt_id IS NULL OR p_receipt_digest IS NULL THEN
    RAISE EXCEPTION 'invalid_operation' USING ERRCODE = '22023';
  END IF;
  -- Serialize retries of one operation and equivalent publication keys.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_namespace || ':' || p_operation_key, 0));
  SELECT * INTO prior FROM idempotency_records
    WHERE namespace = p_namespace AND operation_key = p_operation_key;
  IF FOUND THEN
    IF prior.payload_digest <> p_payload_digest OR prior.briefing_digest <> p_briefing_digest THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT prior.receipt_id, true;
    RETURN;
  END IF;
  SELECT * INTO briefing FROM briefing_revisions
    WHERE namespace = p_namespace AND digest = p_briefing_digest FOR SHARE;
  IF NOT FOUND OR briefing.payload_digest <> p_payload_digest THEN
    RAISE EXCEPTION 'briefing_not_found_or_payload_conflict' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_namespace || ':' || p_briefing_digest || ':' || p_payload_digest, 1));
  SELECT r.id INTO prior_receipt FROM publications p JOIN publication_receipts r
    ON r.namespace = p.namespace AND r.publication_id = p.id
    WHERE p.namespace = p_namespace AND p.briefing_digest = p_briefing_digest
      AND p.payload_digest = p_payload_digest;
  IF FOUND THEN
    INSERT INTO idempotency_records VALUES
      (p_namespace, p_operation_key, p_briefing_digest, p_payload_digest, prior_receipt);
    RETURN QUERY SELECT prior_receipt, true;
    RETURN;
  END IF;
  SELECT * INTO approval FROM approvals
    WHERE namespace = p_namespace AND id = p_approval_id FOR SHARE;
  IF NOT FOUND OR approval.briefing_digest <> p_briefing_digest
      OR approval.reviewer_scope <> p_reviewer_scope OR approval.decision <> 'approved'
      OR approval.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'approval_required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO current_watchlist FROM watchlists
    WHERE namespace = p_namespace AND id = briefing.watchlist_id FOR SHARE;
  IF NOT FOUND OR current_watchlist.current_version <> briefing.watchlist_version
      OR current_watchlist.normalizer_version <> briefing.normalizer_version
      OR current_watchlist.verifier_version <> briefing.verifier_version THEN
    RAISE EXCEPTION 'review_required_watchlist' USING ERRCODE = '55000';
  END IF;
  FOR dependency IN SELECT * FROM briefing_source_dependencies
      WHERE namespace = p_namespace AND briefing_digest = p_briefing_digest ORDER BY source_id LOOP
    SELECT * INTO current_head FROM source_heads
      WHERE namespace = p_namespace AND source_id = dependency.source_id FOR SHARE;
    IF NOT FOUND OR current_head.comparison_head_id IS DISTINCT FROM dependency.expected_head_id
        OR current_head.version <> dependency.expected_head_version THEN
      RAISE EXCEPTION 'review_required_source_%', dependency.source_id USING ERRCODE = '55000';
    END IF;
  END LOOP;
  INSERT INTO publications(namespace, id, briefing_digest, payload_digest, approval_id)
    VALUES (p_namespace, p_publication_id, p_briefing_digest, p_payload_digest, p_approval_id);
  INSERT INTO publication_receipts(namespace, id, publication_id, receipt_digest)
    VALUES (p_namespace, p_receipt_id, p_publication_id, p_receipt_digest);
  INSERT INTO workflow_events(namespace, event_kind, object_id, payload)
    VALUES (p_namespace, 'publication_committed', p_publication_id,
      jsonb_build_object('receipt_id', p_receipt_id, 'briefing_digest', p_briefing_digest));
  INSERT INTO idempotency_records VALUES
    (p_namespace, p_operation_key, p_briefing_digest, p_payload_digest, p_receipt_id);
  RETURN QUERY SELECT p_receipt_id, false;
END;
$$;

-- The public API read role must not receive direct effect-table write grants.
-- SECURITY INVOKER requires function and required table privileges for a separate
-- trusted worker or operator role. Configure and test those grants before use.
REVOKE ALL ON FUNCTION publish_briefing(text, text, sha256_hex, sha256_hex, text, text, text, text, sha256_hex) FROM PUBLIC;
COMMIT;
