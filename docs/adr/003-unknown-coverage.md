# Bounded observations and unknown coverage

Decision: Never infer absence or deletion from incomplete requests.

Source or experiment: GitHub pagination and conditional-request documentation and collector tests.

Rejected alternative: An empty failed response would silently erase the baseline.

Consequence: Attempt and comparison heads remain distinct.

Known limitation: Moving pagination is not an atomic source snapshot.

Reconsideration probe: Controlled HTTP integration and captured live manifests must supplement injected transport tests.

