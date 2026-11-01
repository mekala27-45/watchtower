# Digest-bound review and internal publication

Decision: Bind approval to current evidence dependencies and commit effect and receipt atomically.

Source or experiment: Workflow tests and real post-commit response-loss test.

Rejected alternative: Approving a mutable label would reuse authorization for changed content.

Consequence: Identical committed retries recover before later approval expiry.

Known limitation: This establishes only an internal ledger effect.

Reconsideration probe: Public independent clients and fresh service instances must verify the hosted path.

