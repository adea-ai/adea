# Railway migration acceptance inventory

This inventory coordinates [#1564](https://github.com/adea-ai/adea/issues/1564). It is a source report, not a production acceptance result. The reviewed snapshots name exact PR heads; they do not identify whichever version is currently deployed.

## Scope and evidence

| Scope                                            | Source                                               | Remaining proof                                                                                                                                                                        |
| ------------------------------------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1560: source identity and adapter qualification | #1559                                                | Use verified application identity or an explicit unconfigured target. The PostgreSQL service is not an Adea application deployment; Adea compute currently runs on Cloudflare Workers. |
| #1561: production database and account auth      | #1515                                                | Database/TLS/grant/migration receipts are recorded separately; effective deployed bindings and fresh web/desktop acceptance still need deployment proof.                               |
| #1562: authority freshness and resources         | #1515 and `scripts/cache-database-isolation.test.ts` | Source cache isolation and provider query-cache settings are independent checks. Authentication, session and permission database reads require query caching disabled.                 |
| Local Worker transport classification            | #1525                                                | An ambiguous transport outcome cannot satisfy an application assertion or replay a mutation.                                                                                           |

The dated production database receipt is [Railway production readiness](evidence/railway-production-readiness.md). It records schema ownership, dedicated roles, strict TLS, migration repeatability and Hyperdrive routing. The protected Control Plane contract and its deployment checks are maintained in that repository.

Remaining operational proofs include effective Worker bindings, fresh web/desktop login and PKCE, origin/CSRF refusal, refresh, logout and revocation, account verification/reset delivery, private Control Plane readiness, and the production cost observation after verified cutover. Email verification remains enabled. Inbound forwarding is configured; it does not establish outbound delivery.

## Source scan coverage

The module scans lexical database and account-auth binding references. It reports paths containing database URL names, Hyperdrive, application database/auth imports or Better Auth references. A reference is an inventory hit, not a finding or proof of deployed behavior.

| Field                                           | Actual scope                                   |
| ----------------------------------------------- | ---------------------------------------------- |
| Roots                                           | `apps`, `packages`                             |
| Extensions                                      | `.ts`, `.tsx`                                  |
| Skipped directories                             | `node_modules`, `dist`                         |
| Hidden entries                                  | Skipped, including their descendants           |
| Input                                           | Working tree, including generated declarations |
| Test files in dependency inventory              | Included                                       |
| Test files in import/reconciliation marker scan | Excluded                                       |

Coverage is derived from the requested scan. A narrower scan can report its own results, but cannot produce the approved acceptance inventory. Missing roots, unreadable directories and unreadable files are explicitly listed in `scanIncomplete`; an empty hit list with unreadable paths must not be treated as a successful or complete scan.

The report does not scan repository scripts, workflow files, JSON/YAML/TOML configuration or installed dependencies. It cannot certify repository-wide dependency removal, effective infrastructure settings, permissions, live authority freshness, delivery or login. Those require their own source and operational checks.

The offline suite covers exact coverage, narrowed-scope refusal, missing roots, unreadable subtrees/files, temporary fixtures and cleanup, database-reference discovery and the separation of remaining proof states. Temporary fixtures are removed in `finally` blocks.
