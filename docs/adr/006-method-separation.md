# Separate method evidence

Decision: Keep deterministic baseline, actual local model and recorded model results in separate artifacts.

Source or experiment: Model ledger and method-label tests.

Rejected alternative: Substituting baseline proposals into failed model rows hides model failure.

Consequence: Unexecuted model rows have unavailable quality.

Known limitation: The model demonstration criterion cannot pass without actual inference.

Reconsideration probe: A frozen actual CPU-model run over all registered cases can change that state.

