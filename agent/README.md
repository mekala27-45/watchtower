# Agent integration boundary

The three domain handlers are implemented in tools.mjs and tested with invokeTest. Those events are explicitly contract_test with model_requested false. The actual eve integration is not implemented or executed in this candidate because eve, ai, zod and the provider adapter are not installed, and the local model endpoint probe failed. No test invocation is counted as an actual model tool call.

Run node agent/run-model.mjs after fixture generation to produce a complete missing-result ledger for the frozen subset. This command probes prerequisites and records unexecuted rows. It never substitutes the deterministic baseline. It exits with a nonzero status when actual inference is unavailable.

Before adding an actual adapter, install and pin compatible dependencies, read the installed eve documentation, disable optional default tools, remove reachable catalog and delegation tools, and inspect the exact runtime inventory. The public eve documentation states that defaultTools false does not disable catalog tools. A three-name source registry alone therefore cannot establish the runtime tool boundary. Prove a model-generated request, validated handler execution and returned result on development fixtures before freezing an adapter. Then enforce the registered turn, tool, token and time budgets and record the model artifact digest and actual CPU placement.

Primary sources read on 2026-11-01 are https://github.com/vercel/eve/blob/main/docs/concepts/built-in-tools.md, https://github.com/vercel/eve/blob/main/docs/agent-config.md and https://docs.ollama.com/capabilities/tool-calling. These mutable documentation pages guide future integration and do not establish installed version compatibility.

