# Auth package

Provider-neutral authentication boundary for Adea. The root export contains normalized types
and adapters. `/auth/server` is the only server-side Neon Auth integration, and
`/auth/client` is the only client-side integration.

Authentication is optional for guest use. It proves a provider credential when a user chooses to
persist a temporary workspace, but it never grants workspace access by itself. See [the
authentication operations guide](../../docs/authentication.md) for temporary users, workspace
claiming, authorization, security, callbacks, observability, and provider-migration conventions.
