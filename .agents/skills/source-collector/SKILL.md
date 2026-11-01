---
name: source-collector
description: Validate Watchtower collection changes, cache behavior and uncertainty.
---

Read AGENTS.md and the relevant source contract. Run the clean normalized collection case, a forbidden host and expired-cache violation, and the missing-cache or empty-input refusal. Preserve the prior comparison head on every failed attempt. Do not count an injected transport test as a live request.

Run `node --test tests/collector.test.mjs`. Keep every failure and evidence artifact. These procedures belong to this repository and are not additional runtime agents.

