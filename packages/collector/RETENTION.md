# Collector retention

`retention.mjs` selects collector artifacts independently of domain evidence. The SQLite and PostgreSQL adapters apply its plan in a short transaction. PostgreSQL takes namespace, source-head and lease locks in the same order as the writer paths. HTTP is outside these transactions.

The default policy keeps the most recent 100 watchlist jobs and the most recent 100 attempts for each source. It also pins current source heads, exact briefing before/after observations and source dependencies, the latest two usable revisions of each item, unexpired usable cache entries, and active or recently unfinished jobs. A retained job keeps all its source manifests and request attempts together.

Only unreferenced collector jobs, run manifests, request attempts and expired or invalid cache entries are eligible. This operation never deletes observations, evidence revisions, briefing approvals, publications or immutable receipts. Approved or published briefings remain reference roots after source heads advance. Source observation IDs retain collection run-key identity after an old collector manifest is pruned, preventing network replay of a committed run key.

The collector artifacts are limited to 10,000 rows and 16 MiB of serialized payload per namespace. A plan that cannot retain all pins inside those limits refuses before deleting anything. PostgreSQL measures JSONB text bytes using the database serialization. Collector commit also enforces the row and byte cap, so excess staged artifacts roll back with the observation and head update.

Pruning happens before a new collection job and after its outcome is persisted. A failed or incomplete collection does not erase a last usable comparison head. Expiring a cache entry does not turn its evidence into a negative observation.

`tests/retention.test.mjs` independently verifies more than 100 jobs, pinned published dependencies, replay refusal, namespace separation, latest revisions, expired caches, budget refusal and rollback after an interrupted deletion. `tests/retention-postgres.test.mjs` uses two independent actual PostgreSQL pools when `WATCHTOWER_TEST_DATABASE_URL` is supplied; without that variable it explicitly reports a skipped database test. The latter tests fenced cached collection, published dependency retention, budget rollback, staged-artifact rollback and stale-worker rejection. Synthetic test captures remain in unique `test:` namespaces.
