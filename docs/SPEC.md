# API contract

The local contract is watchtower-local-v1. Health reports liveness, local database readiness, build revision, contract version and backend label. productionReady remains false for the local adapter.

Read routes are GET /health, GET /api/sources, GET /api/runs/:id, GET /api/evidence/:id, GET /api/briefings, GET /api/briefings/:id and GET /api/reports/current. Public reads use only the live namespace. Missing records return not_found without revealing another namespace.

POST /api/demo/sessions accepts an empty JSON object and returns a random capability once. Keep it in memory and send it in the Authorization Bearer header. GET /api/demo/sessions/:id reads that session. POST /api/demo/sessions/:id/prepare accepts an empty object. Approve accepts digest. Publish accepts digest and operationKey. The resulting briefing is derived from authored fixtures through detector and verifier code. Approval represents the isolated synthetic reviewer.

Each mutation rejects unknown fields, oversized bodies, invalid content types, untrusted origins and missing capabilities. The local store enforces persistent creation and session quotas. The client must recover an uncertain publication response with the same operation key and digest. An identical committed retry returns the existing receipt. A changed digest returns conflict. A stale dependency requires review again.

Success responses use JSON and namespace or mode context. Error responses use error.code and error.message with sanitized codes. Invalid input returns 400, missing capability 401, forbidden origin 403, absent scoped record 404, expired session 410, conflict 409, oversized request 413, wrong media type 415 and quota exhaustion 429. An unexpected internal failure returns 500 without raw errors. Broken readiness returns 503.

There is no collection, inference, arbitrary source URL, SQL or shell route. Operator commands and model execution stay outside public requests. Every static metadata value uses safe DOM text insertion.

The API tests call the real request handler using stream objects. They do not claim TCP or browser execution. Re-run against a listening server and independent process when the networking restriction is removed.

