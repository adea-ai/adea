# Immutable source contract test fixture

The nine `source/*.snapshot` files are byte-for-byte TypeScript blobs from
`adea-ai/control-plane` commit `6c296fbe561b755bda0fa87f7e1a05ab451bc2f7`.
`provenance.json` records their original paths, Git blob IDs and SHA-256 hashes.
`LICENSE` is copied from that commit. No schemas are rewritten or made permissive.

The fixture has its own private package and frozen lockfile for the original
Zod 4.6.5 dependency. It is not published and does not depend on a sibling checkout.

From a clean Adea checkout with the pinned Bun toolchain:

```sh
bun install --frozen-lockfile --ignore-scripts
bun scripts/setup-source-contract-tests.mjs
bun test ./apps/web/test/lead-source-contract.test.ts
```

Normal `bun run --cwd apps/web test` runs the same setup automatically. Direct
test invocation requires the explicit setup above. Missing or changed fixtures,
dependency or generated runtime fail visibly; coverage is never silently skipped.
Use `bun scripts/setup-source-contract-tests.mjs --verify-only` to check an
already prepared fixture without installing or generating anything.

Setup verifies the source/setup/license hashes, installs only the frozen private
fixture dependency if missing, and copies the exact source bytes into ignored
`.runtime/*.ts` files for Bun. Snapshots are stored as data so project formatting
and lint rules cannot rewrite upstream source. The generated runtime is also
hash-checked before import. It is neither deployment output nor an SDK release.

To audit provenance, fetch the full pinned CP commit into an explicitly chosen
CP clone and compare `git show <commit>:<original path>` with each snapshot and
its recorded Git blob/SHA-256. Regeneration requires an intentional reviewed pin
update; setup never fetches branches or follows a mutable checkout.
