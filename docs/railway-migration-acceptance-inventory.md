# The Railway migration acceptance inventory

**Scope:** issue #1564 — the **parent** coordination issue. Railway is the chosen
migration target, and this inventory tracks the remaining acceptance across
Adea and the Control Plane **without treating source-only tests as cutover
proof**.

**This issue authorizes source, tests and documentation only.** No credential,
paid resource, production data copying, deployment, cutover, Neon deletion or
permission change is performed or authorized here. The fresh-account, provider
and cutover acceptance stays **gated** until separately approved evidence
exists, and the one-week cost observation starts only after a verified cutover.

## Ownership: the parent coordinates, the children implement

The implementation stays with each child scope's single reconciled owner. This
inventory does not duplicate them; it records what they own and what is left.

| Child scope                                          | Subject                                           | Branch                                                        |
| ---------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------- |
| [#1560](https://github.com/adea-ai/adea/issues/1560) | Railway source identity and adapter qualification | `recovery/issue-1560-w9-20261021`                             |
| [#1561](https://github.com/adea-ai/adea/issues/1561) | separately gated provider and readback acceptance | `recovery/issue-1561-fresh-account-readback-plan`             |
| [#1562](https://github.com/adea-ai/adea/issues/1562) | freshness and resource safeguards                 | `recovery/issue-1562-cloudflare-cpu-hyperdrive-qualification` |

Related open source work, by exact reviewed head: **PR #1515** at
`312c49db2e77371cf38a5397c386439494e53019` (provider-coupling removal) and
**PR #1525** at `f37411f4d` (auth transport-loss classification). Their checked-out
source does not establish a live provider acceptance result.

## The inventory

`scripts/railway-migration-acceptance-inventory.ts` derives the record from the
repository's own sources:

- **the remaining Neon / provider-auth dependencies**, as the source paths that
  still name the Neon provider or its authentication;
- **the forbidden migration markers** — a legacy account, password or session
  import, a dual write, or an old-data reconciliation — across the migration
  sources (the test files are excluded, because a test may name a marker to
  assert its absence);
- **the freshness qualification** this parent depends on
  (`scripts/cloudflare-cpu-hyperdrive-qualification.ts`, whose
  `authority-reads-not-cache-disabled` rule is what proves auth, session and
  permission reads cannot use stale caches — the #1562 scope's work, referenced
  here, not repeated).

The applicable tests are the child scopes' own suites plus this inventory's
suite:

```sh
bun test scripts/railway-migration-acceptance-inventory.test.ts
```

## The acceptance that stays gated

| Gate                                                                                      | State          |
| ----------------------------------------------------------------------------------------- | -------------- |
| fresh web and desktop login, PKCE, origin/CSRF, logout/revocation, reset and verification | gated          |
| live Railway target and readback                                                          | gated          |
| provider qualification                                                                    | gated          |
| operational cutover and the one-week cost observation                                     | gated          |
| production data copying, Neon deletion and permission changes                             | not authorized |

## Neon preservation and the cutover prerequisites

Neon remains **preserved and recoverable** for the duration of the migration:
nothing in this work deletes a Neon database, copies production data, rewrites
or reconciles old rows, or changes a permission. The operational cutover
prerequisites — the disposable fresh-account lifecycle, the readback, the
provider qualification and the cost observation — are separate from the source
qualification and are listed above as gates. A source-only test is not cutover
proof, and the issue's unchecked links are dependencies and evidence to
qualify, not completion claims.
