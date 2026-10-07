# API client

Typed client helpers for Adea backend requests. Keep transport and response
mapping here so UI packages do not depend on a specific HTTP implementation.

`TaskSubmissionApiClient` from `@adea-ai/api-client/task-submission` supplies the initial encrypted Task delivery-intent
methods separately from the normal workspace client. Callers seal the input to
the selected RuntimeNode's verified command-encryption `keyId` and keep the
same request ID, idempotency key, Task version, profile revision and envelope on
retry. The response reports pending delivery or expiry, not execution acceptance.
