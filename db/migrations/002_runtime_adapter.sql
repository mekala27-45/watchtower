-- Runtime compatibility additions. Apply after 001 on an isolated branch first.
BEGIN;
SET LOCAL search_path = watchtower, pg_catalog;

ALTER TABLE sources DROP CONSTRAINT sources_repository_label_check;
ALTER TABLE sources ADD CONSTRAINT sources_repository_label_check CHECK (
  repository_label IN ('vercel/eve','ollama/ollama','microsoft/playwright','vitejs/vite')
  OR (namespace <> 'live' AND repository_label LIKE 'authored/%'));
ALTER TABLE observations DROP CONSTRAINT observations_state_check;
ALTER TABLE observations ADD CONSTRAINT observations_state_check
  CHECK (state IN ('captured','partial','unavailable','unstable','deferred'));
ALTER TABLE observations ADD COLUMN runtime_payload jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(runtime_payload) = 'object');
ALTER TABLE approvals ADD COLUMN reviewer text NOT NULL DEFAULT 'migration';
ALTER TABLE publication_receipts ADD COLUMN payload jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(payload) = 'object');
ALTER TABLE demo_sessions ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();

CREATE TABLE demo_session_limits (
  namespace text NOT NULL DEFAULT 'system:demo_quota' CHECK(namespace = 'system:demo_quota'),
  client_key text NOT NULL, window_start bigint NOT NULL, count integer NOT NULL CHECK(count BETWEEN 1 AND 5),
  PRIMARY KEY(namespace,client_key,window_start)
);
CREATE TABLE collector_jobs (
  namespace text NOT NULL REFERENCES namespaces(namespace), id text NOT NULL,
  plan_digest sha256_hex NOT NULL, started_at bigint NOT NULL, finished_at bigint,
  state text NOT NULL, payload jsonb NOT NULL, PRIMARY KEY(namespace,id)
);
CREATE TABLE collector_runs (
  namespace text NOT NULL, run_id text NOT NULL, job_id text NOT NULL,
  source_id bigint NOT NULL, payload jsonb NOT NULL, PRIMARY KEY(namespace,run_id),
  FOREIGN KEY(namespace,run_id) REFERENCES observations(namespace,id),
  FOREIGN KEY(namespace,job_id) REFERENCES collector_jobs(namespace,id),
  FOREIGN KEY(namespace,source_id) REFERENCES sources(namespace,source_id)
);
CREATE TABLE collector_attempts (
  namespace text NOT NULL, run_id text NOT NULL, request_id text NOT NULL,
  payload jsonb NOT NULL, PRIMARY KEY(namespace,run_id,request_id),
  FOREIGN KEY(namespace,run_id) REFERENCES observations(namespace,id)
);
CREATE TABLE collector_cache (
  namespace text NOT NULL, source_id bigint NOT NULL, cache_key sha256_hex NOT NULL,
  run_id text NOT NULL, generation bigint NOT NULL CHECK(generation>0), payload jsonb NOT NULL,
  PRIMARY KEY(namespace,source_id,cache_key),
  FOREIGN KEY(namespace,source_id) REFERENCES sources(namespace,source_id),
  FOREIGN KEY(namespace,run_id) REFERENCES observations(namespace,id)
);
CREATE INDEX collector_jobs_retention_idx ON collector_jobs(namespace,started_at DESC,id);
CREATE INDEX demo_sessions_expiry_idx ON demo_sessions(expires_at);

CREATE TRIGGER publications_no_delete BEFORE DELETE ON publications
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER publication_receipts_no_delete BEFORE DELETE ON publication_receipts
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER idempotency_records_no_delete BEFORE DELETE ON idempotency_records
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER collector_runs_immutable BEFORE UPDATE ON collector_runs
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER collector_attempts_immutable BEFORE UPDATE ON collector_attempts
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
COMMIT;
