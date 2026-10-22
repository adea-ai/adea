# Railway production readiness

Verified on 2026-10-22 through authenticated Railway SSH:

- Project `18c6a1fd-6b4b-421e-9ec9-fd1550ce9a3f`, production environment `52f5b0ac-2af0-4792-aa56-30d80e5db31e`.
- PostgreSQL service `67fdd979-8a5b-4c02-b4c5-799a2e5cb3f0`; database `railway`.
- Private endpoint `postgres.railway.internal:5432`; public proxy `altaria.proxy.rlwy.net:44407` forwards to 5432.
- `adea_prod_migration` owns `app` and `auth`; both were empty at bootstrap. No elevated role flags, memberships, database-wide CREATE, or public-schema CREATE were granted. PUBLIC has no privileges on the Adea schemas.
- Certificate peer identity `postgres.railway.internal`; the public proxy hostname is absent from its SANs. Authenticated CA DER SHA-256: `3022dc74d0ca3f397259f884ae46f49ce41a51b6208a71a6a30d7fcf142f9c90`. Verified TLS 1.3 through the public proxy with that CA and peer identity.

Runtime credentials, schema migrations, delivery configuration, cache-disabled routing, effective deployed bindings, and fresh-account login acceptance remain separate operational prerequisites. Source tests and liveness alone do not prove them.
