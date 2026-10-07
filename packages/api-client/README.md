# API client

Typed client helpers for Adea backend requests. Keep transport and response
mapping here so UI packages do not depend on a specific HTTP implementation.

`TaskSubmissionApiClient` from `@adea-ai/api-client/task-submission` supplies the initial encrypted Task delivery-intent
methods separately from the normal workspace client. Callers seal the input to
the selected RuntimeNode's verified command-encryption `keyId` and keep the
same request ID, idempotency key, Task version, profile revision and envelope on
retry. The response reports pending delivery or expiry, not execution acceptance.

`RuntimeNodeDeliveryClient` from `@adea-ai/api-client/runtime-node-delivery`
uses only a node's signed pull proof, omits cookies/user credentials, rejects
redirects and bounds time/response bytes. The host supplies the proof from its
trusted signing-key boundary and must validate the returned envelope, local
authority and durable inbox before dispatch. A pull is not an execution receipt.
