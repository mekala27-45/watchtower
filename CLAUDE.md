# Claude instructions

Read AGENTS.md first. Follow the same Postgres architecture, fixed source policy, tool inventory and verification commands. Retain namespace and method identity at every boundary. Use the checked-in lockfile and immutable container image.

Validate an archived model run with `node scripts/verify-report-evidence.mjs --archived`. This is not new inference. Preserve failed rows and independent baseline results. Do not replace actual evidence with a contract handler or claim a hosted result from a local test. Keep incomplete checklist entries and secret-transfer blockers explicit.
