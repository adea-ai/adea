# Railway cutover checklist

Production uses one Railway PostgreSQL service. The verified target and TLS provenance are recorded in [production readiness](../evidence/railway-production-readiness.md). Tests use disposable PostgreSQL sandboxes with synthetic accounts and independent credentials.

## Required order

1. Verify project, production environment, database service, database name, schema ownership, and the exact runtime and migration roles.
2. Verify the authenticated CA and certificate peer identity through every transport route. Use strict certificate and hostname verification; never accept a plaintext fallback.
3. Apply application migrations with `adea_prod_migration`; the guarded runner checks history and deterministic reruns. Initialize Better Auth tables in `auth` with its operator plan/apply command, using a single-schema search path.
4. Grant runtime roles only the required schema usage, table DML, sequence access, and application function execution. Runtime roles have no schema CREATE or elevated role flags.
5. Configure account Secrets Store bindings, query-cache-disabled Hyperdrive routing, and verification/reset delivery. Read back the configuration without exposing credentials.
6. Run fresh-account acceptance: verification delivery, verified login, web/desktop PKCE, origin/CSRF refusal, refresh, logout, revocation, and password reset. Keep verification enabled.
7. Merge the exact validated source heads and verify production database readiness, effective bindings, private connectivity, and the application journeys after deployment.

A successful liveness deployment does not establish schema readiness or login acceptance. One-week cost observation begins after the verified cutover. Recovery uses Railway backup/restore or a reviewed forward fix.

See [fresh PostgreSQL acceptance](fresh-postgres-acceptance.md), [database operations](../database-operations.md), and [Railway cost week](railway-cost-week-plan.md).
