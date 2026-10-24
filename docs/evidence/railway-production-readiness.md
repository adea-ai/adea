# Railway production readiness

Verified on 2026-10-22 through authenticated Railway SSH, the existing public proxy, and provider readback:

- Project `18c6a1fd-6b4b-421e-9ec9-fd1550ce9a3f`, production environment `52f5b0ac-2af0-4792-aa56-30d80e5db31e`.
- PostgreSQL service `67fdd979-8a5b-4c02-b4c5-799a2e5cb3f0`; database `railway`.
- Private endpoint `postgres.railway.internal:5432`; existing public proxy `altaria.proxy.rlwy.net:44407` forwards to 5432.
- `adea_prod_migration` owns only `app` and `auth`; no elevated role flags, memberships or database-wide CREATE. `adea_prod_app` and `adea_prod_auth_app` receive DML only in their respective schemas. PUBLIC has no privileges on those schemas.
- The leaf certificate validates `localhost`, `postgres.railway.internal` and `altaria.proxy.rlwy.net`. Leaf DER SHA-256 is `b3bfc0c18336f8a27bf11a99f7a0a4dc05b5e8736cb144a6f31a0908a1f20b68`; authenticated CA DER SHA-256 remains `3022dc74d0ca3f397259f884ae46f49ce41a51b6208a71a6a30d7fcf142f9c90`. Both endpoint identities were verified independently over TLS through the public proxy; no private key left the service.
- Application migrations applied all 61 canonical files, then replay left history unchanged. Auth initialization created `account`, `session`, `user` and `verification`; subsequent planning returned no pending changes.
- GitHub `DATABASE_MIGRATION_URL` uses the dedicated migrator. Worker database/auth configuration records exist in Secrets Store. Existing Hyperdrive `5faad934a0a14a29bbb4780ca2f53fa6` now uses Railway, `adea_prod_app`, the uploaded public CA, verify-full and disabled query caching.
- The production email binding uses `team@adea.dev`. An inbound forwarding rule to the owner's verified destination exists. Outbound Email Sending access returned 401; successful verification/reset delivery is not established.

Effective deployed bindings, private runtime connectivity, readiness and fresh-account acceptance remain deployment checks. Source tests, migrations and liveness alone do not prove them. Keep email verification enabled.
