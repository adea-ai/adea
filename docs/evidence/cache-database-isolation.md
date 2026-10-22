# Cache database isolation

The optional R2 task cache is disabled by default. Cache tooling does not select a production database or read application database credentials. `scripts/cache-database-isolation.test.ts` checks the tooling boundary, workflow defaults, and local-cache fallback.

This source check does not establish the production Hyperdrive query-cache setting. Authentication, session, and permission reads require a separately verified cache-disabled route.
