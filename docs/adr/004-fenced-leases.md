# Fenced leases and short transactions

Decision: Check generation, database-clock expiry and expected head before committing.

Source or experiment: Workflow tests and actual child-process rollback test.

Rejected alternative: An owner string alone permits an expired worker to return.

Consequence: External work stays outside the database transaction.

Known limitation: SQLite proof must be repeated against Neon Postgres.

Reconsideration probe: Independent Neon connections and stale returning workers must reproduce the same invariants.

