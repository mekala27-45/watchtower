# Local workflow contract

Store uses the Node native SQLite implementation. Every response labels this backend sqlite_local_candidate. This working adapter does not establish PostgreSQL or hosted durability.

Construct Store with a disposable database path. The constructor installs local constraints and enables foreign keys and WAL. now reads the database clock. External network requests and inference must finish outside a transaction.

registerSource takes namespace, positive numeric source ID and a display label. acquireLease takes namespace, source ID, owner and bounded TTL in milliseconds. It returns owner, generation, database-clock expiry and expectedHead. renewLease requires the still-current, unexpired generation. releaseLease expires only that generation.

recordObservation takes namespace, sourceId, lease, expectedHead, evidence, status, coverage, scope and runId. A matching generation alone is insufficient: owner, database expiry and expected comparison head must also match. The short transaction stores admitted evidence, observation membership, previous comparison head, latest attempt, eligible comparison head and event atomically. Failure states retain the comparison head. A trusted synchronous onCommit callback may persist associated safe request and cache artifacts within this transaction. It receives db, namespace, runId and now. HTTP input never controls this callback.

prepareBriefing accepts deterministic baseline proposals plus a valid evidence bundle and persisted beforeRunId and afterRunId. It checks actual observation membership, order through previousComparisonHead, source identity, scope, current heads, method, coverage and every independent predicate decision. Supplied supported flags do not authorize a finding. Local agent and recorded agent labels require an inference receipt path that is not implemented, so this store refuses both.

approveBriefing records a specific briefing digest, reviewer scope and expiry. publishBriefing checks an existing identical operation first. It returns the original committed receipt even if approval subsequently expired. Changed payloads conflict. New effects require current source dependencies, current evidence and unexpired scoped approval. Publication, receipt and event commit together.

Demo wrappers expose createDemoSession, getDemoSession, prepareDemo, approveDemo and publishDemo. They accept an opaque capability outside the URL. Only its digest is stored. The persistent quota admits five sessions per client key per hour and sixty mutations per session, with thirty minute expiry. The global creation limit is one thousand sessions and a fifty million byte database capacity refusal. The HTTP layer hashes the client identity before passing clientKey.

prepareDemo creates two authored observations and calls the real domain normalizer, detector, baseline proposal generator, verifier and claim renderer. It never converts a baseline into an actual model result. Its reviewer identity is synthetic_reviewer.

Read methods include listSources, getRun, getEvidence, listBriefings, getBriefing and getReceipt. They require a namespace and return no cross-namespace records. pruneEvidence keeps at least the latest two revisions per item, every briefing reference and source head references. It refuses budgets that would require deleting pinned evidence. The default retention cap is ten thousand evidence rows and fifty million retained evidence bytes.

Run node --test tests/workflow.test.mjs tests/faults.test.mjs. Run node scripts/fault-matrix.mjs for the registered held-out overlay matrix. The matrix uses fresh disposable databases, injected HTTP responses and real child process termination. It reports these limits explicitly and does not claim live network or PostgreSQL proof.
