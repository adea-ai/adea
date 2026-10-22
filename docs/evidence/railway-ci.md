# Railway database CI

Pull-request database qualification uses disposable loopback PostgreSQL and synthetic identities. Production database migration runs separately through `.github/workflows/cloudflare-db-migrate.yml` with the repository secret `DATABASE_MIGRATION_URL`.

The migration target validates database, role, transport host, port, peer identity, and public CA fingerprint before connecting. The migration driver enforces certificate verification. A public TCP proxy's address and its PostgreSQL certificate identity are recorded independently.

There is one persistent Railway environment: production. Disposable test sandboxes must not receive production credentials or application traffic.
