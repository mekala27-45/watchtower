# PostgreSQL runtime

`PostgresStore` in `postgres.mjs` is the asynchronous production adapter. It uses the normalized `watchtower` schema from `db/migrations/001_watchtower.sql` plus `002_runtime_adapter.sql`. The SQLite adapter remains a separately labeled local candidate.

```js
import {PostgresStore} from './packages/workflow/postgres.mjs';
const store = await PostgresStore.create({connectionString: process.env.DATABASE_URL});
await store.ready();
// Every public Store operation is awaitable.
await store.close();
```

Supply a direct PostgreSQL endpoint. The driver is `pg`, dynamically imported only for this backend. TLS validates the server certificate; URL SSL switches are stripped before the verified TLS policy is applied. Credentials are read from the environment and never returned by the adapter. A caller may inject a trusted `pg.Pool` for testing. Pool injection is an application initialization capability, not an HTTP request option.

Run migrations explicitly with `PostgresStore.create({migrate:true})` against an isolated development branch first. Migrations are ordered and each migration plus its ledger entry commits atomically. Runtime startup defaults to `migrate:false` and checks required schema relations. No migration runs from a browser request. A session advisory lock serializes migration runners on the direct connection.

Every workflow transaction checks out one client, sets a transaction-local schema path, and commits or rolls back on that same client. Namespace rows lock source-set changes; ordered source-head locks protect lineage and stale review checks. Lease owner, generation, database-clock expiry and expected comparison head are all checked. Expiry is checked again after an asynchronous collector commit hook, so stale workers cannot commit after a slow hook. Immutable evidence, observations, typed proposals, verification decisions, briefing revisions, approval revisions, publications, receipts and events are persisted independently.

`recordObservation` accepts an optional trusted async `onCommit({db,namespace,runId,now})` hook. Here `db` is the checked-out transaction client, not the pool. Collector attempts, durable cache updates and observation/head changes therefore share one commit. Callback code must use this client and must not perform network collection while holding the transaction.

Briefing preparation recomputes typed predicates against evidence actually present in the persisted before/after observations. It rejects unsupported findings, spoofed model labels, fabricated lineage, coverage mismatches and missing evidence. Baseline results remain `deterministic_baseline`; local-model inference provenance is not invented by the workflow adapter. Source, watchlist, normalizer and verifier changes require review again. Stale-source errors return at most80 source labels from the same namespace.

Publication locks the namespace-scoped idempotency key, checks for an existing immutable receipt before checking current review state, validates an unexpired scoped approval and all pinned evidence, and inserts publication, receipt, idempotency record and event together. A postcommit lost response can therefore be recovered from another connection even if the source changes afterward. A changed payload under an existing operation key conflicts. Receipts and publications cannot be deleted by ordinary application SQL.

Demo capabilities are random, stored only as digests, namespace scoped and database-clock expiring. Creation quotas and mutation quotas use row/advisory locks so concurrent clients cannot overconsume them. Storage/session bounds fail closed. Evidence pruning retains recent revisions and referenced evidence; an impossible pinned minimum rolls the whole pruning transaction back.

## Verification

`tests/postgres.test.mjs` contains real database contracts: independent connections, competing lease workers, expiry during a commit hook, transaction rollback, durable proposal/verification lineage, concurrent publication, postcommit response loss, stale review, capability isolation and quota races. These tests use `WATCHTOWER_TEST_DATABASE_URL`; if absent, the suite explicitly skips database execution. Set `WATCHTOWER_TEST_MIGRATE=1` only when applying the checked-in migrations is intended.

```sh
node --test tests/postgres.test.mjs tests/retention-postgres.test.mjs
```

Database runs require an isolated test database and create unique test/demo namespaces. Tests retain their immutable receipts as evidence; they do not disable immutability triggers or reset a shared database. Actual execution records belong in `reports/verification`; passing SQLite tests or checking SQL text does not prove PostgreSQL behavior.

Driver references: [transactions](https://node-postgres.com/features/transactions), [TLS configuration](https://node-postgres.com/features/ssl). Both were consulted when implementing this adapter.
