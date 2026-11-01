# Persistence targets

The working local candidate uses the native Node SQLite adapter in packages/workflow/store.mjs. Independent local connections and process interruption tests exercise that adapter. They do not establish Neon connectivity, PostgreSQL transaction behavior or public service durability.

The PostgreSQL target is db/migrations/001_watchtower.sql. It is prepared and has not been executed against PostgreSQL. It defines namespace composite keys, reference constraints, immutable revision records, scoped method labels and a short internal publication function. Apply it only to a disposable watchtower database for validation before connecting the deployed API.

The publication function recovers an identical existing operation before checking expiry. A different payload under the same key is a conflict. New publication checks the approved revision, scope, expiry, watchlist versions and source heads, then writes the publication, receipt, event and idempotency record inside the caller transaction. A publication does not send an external message.

The target still needs direct verified TLS, migration execution, independent connection tests, fenced collection transaction integration, server role grants, reference retention tests and process interruption checks on PostgreSQL. Source head advancement must compare the lease generation, lease owner, database clock expiry and expected head in one transaction. The schema alone does not perform that transition.

The application service must validate canonical digests and schema input before writes. Checks on JSON top level fields are defense in depth, not a replacement for metadata normalization. Source bodies and personal profile fields must never be admitted to evidence.

Use a migration owner separate from the API read role and the authenticated worker or operator role. The function is SECURITY INVOKER and public execution is revoked. The trusted worker or operator caller needs execution and the required table privileges. Deployment grants need review and integration tests. No broad role grants are provided by this untested target.

Transaction advisory locks and row lock behavior follow the PostgreSQL documentation at https://www.postgresql.org/docs/current/explicit-locking.html. Function caller privileges follow https://www.postgresql.org/docs/current/sql-createfunction.html. These sources were checked on 2026-11-01. The local environment has no psql executable, so no migration parse or execution result is claimed.
