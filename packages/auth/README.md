# Auth package

Provider-neutral authentication boundary for Agent HQ. The root export contains normalized types
and adapters. `@agent-hq/auth/server` is the only server-side Neon Auth integration, and
`@agent-hq/auth/client` is the only client-side integration.

Authentication proves a provider credential. It does not create a domain User or grant workspace
access. See [the authentication operations guide](../../docs/authentication.md) for security,
environment, callback, observability, and provider-migration conventions.
