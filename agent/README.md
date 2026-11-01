# Watchtower local agent

The actual runtime uses pinned eve 1.0.0-rc.1 and AI SDK 7.0.159 with the CPU-only Qwen3-0.6B Q4_K_M artifact recorded in `docs/model-config.json`. The native Ollama adapter implements the documented AI SDK LanguageModelV4 interface. It translates only provider-native `message.tool_calls`; ordinary JSON-looking model text remains text. The original OpenAI-compatible development attempts and the single adapter adjustment remain recorded in `reports/model/runs/` and `docs/model-adapter-adjustment.json`.

`agent.ts` disables optional defaults and root delegation. There are no skills, connections, deferred capabilities, tasks or subagents. Start eve with `--no-default-extensions` as well. Every dispatched provider request checks that its runtime inventory is exactly `list_changes`, `inspect_snapshot`, and `propose_finding`. A source registry alone never counts as proof.

Set `WATCHTOWER_RUNTIME_DIR` to the absolute `state/model-runtime` path in this repository for both processes, then run:

```text
node node_modules/eve/bin/eve.js dev --no-ui --no-default-extensions --host 127.0.0.1 --port 2001
node agent/eve-evaluator.mjs --development
```

The development command probes the pinned artifact, actual CPU placement, native tool protocol, and three authored development cases. It records all attempts, including malformed calls, timeout, failure, and explicit no-op. Before heldout evaluation, commit and freeze the prompt, schemas, adapter, model config and registered plan. Then run `node agent/eve-evaluator.mjs` once for the fixed 24-case subset. Never tune on its failures.

All transitions within a sequence share three model requests, four tool executions, 256 output tokens per response and a 60-second deadline. The native request fixes `num_gpu: 0`, `num_ctx: 8192`, temperature 0 and seed 23. `/api/ps` must show zero VRAM and the pinned digest before and after evaluation.

`runtime-boundary.mjs` matches each eve handler execution to an unused provider-emitted name and exact arguments. `tools.mjs` remains a tested domain boundary: its `invokeTest` events stay `contract_test` and are never counted as inference. Actual receipts record dispatched requests, provider tool calls, validated handler executions and returned results separately. Rejected framework-schema calls remain in the provider-call and eve-event trace even when no handler executes.

`actual-ledger.mjs` independently grades exact factual operands against authored fixture truth. Only deterministic verifier-supported facts can become review previews; they remain unapproved and unpublished. Actual results live under `reports/model/`; deterministic results remain under `reports/baseline/`. `run-model.mjs` retains the prerequisite/unavailable ledger path for environments that cannot run actual inference.

Installed sources checked: `node_modules/eve/docs/README.md`, `agent-config.md`, `tools/index.mdx`, `concepts/built-in-tools.md`, `guides/client/`, `reference/cli/index.md`, AI SDK v4 provider type sources, and the official Ollama `/api/chat`, tool-calling, and `/api/ps` documentation.

