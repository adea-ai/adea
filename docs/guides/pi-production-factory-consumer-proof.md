# Reproduce the installed SDK and production-factory proof

The executable fixture is `packages/db/tests/fixtures/lead-production-factory-consumer-proof.mjs`.
It uses the web application's actual installed `LeadSdkPort`, signed SDK requests,
CP's real production factory and retained SQLite publication reader, and Adea's
restricted PostgreSQL product reader and timeline transaction. It does not inject
an SDK port, runtime status, retained record, or publication response.

The normal DB unit inventory discovers the preflight and process-fault test files.
The connected fixture is intentionally opt-in: ordinary unit/integration jobs must
not start another repository's host or acquire a database without explicit inputs.

## Prerequisites

Use an isolated consumer checkout and an owned, already-migrated PostgreSQL database
with the existing restricted application role. Never use a production database or
add role privileges. Build the ordinary DB dependency closure before the fixture:

```sh
bun install --frozen-lockfile
bunx --no-install turbo run build --filter=@adea-ai/db --concurrency=2
```

Obtain a reviewed, clean CP candidate checkout with
`scripts/pi-production-factory-candidate.mjs`, its normal frozen dependencies/build,
and a trusted immutable `pi-durable-candidate-artifacts/v1` manifest. Record the
expected full Git head independently. The manifest lists the three public archives,
their versions, byte counts and SHA256 hashes, and the checkout's source digest.
The fixture verifies all of them before opening a database connection, plus the
web SDK module and both transitive contracts module identities, and compares their
installed package payload bytes with the verified archives. Static application imports
load packages before preflight; every check still precedes the first DB connection.
It requires all
eight real SDK methods and their exported request/response schemas.

If the registry does not contain these capabilities, use the actual public candidate
archives **only in the isolated consumer**: temporary file dependencies for the web
SDK/contracts, and necessary root contracts/runtime-SDK transitive overrides. Record
original and candidate manifest/lock bytes and hashes. Install offline, and keep
these temporary dependencies, lock edits, archive paths and keys out of commits.
No aliases, fabricated versions, private CP imports, or mocked SDK fallbacks qualify.
Missing installed support fails with `PI_FACTORY_PROOF_UNSUPPORTED_INSTALLED_SDK`.

## Invocation and ownership

Supply absolute local paths through environment variables, not product manifests:

```sh
export DATABASE_URL='<owned restricted-role database URL>'
export PI_FACTORY_CP_ROOT='<clean reviewed CP checkout>'
export PI_FACTORY_BUN='<pinned Bun 1.4.2 executable>'
export PI_FACTORY_MANIFEST='<verified candidate manifest.json>'
export PI_FACTORY_EXPECTED_HEAD='<independently confirmed full 40-character head>'
bun --conditions=react-server packages/db/tests/fixtures/lead-production-factory-consumer-proof.mjs
```

Start the owned PG cluster with an explicit loopback host/port and require
`pg_isready` for that exact database/role before invocation. Use an EXIT trap to
fast-stop only that cluster, then verify its postmaster PID and listener are gone.
The fixture closes its reader, database connection and exact spawned CP child; its
bounded shutdown escalates only that child and preserves a primary proof failure.
Asynchronous spawn errors and process close settle startup only once. Missing or
non-executable binaries still run every owned cleanup. Failure records contain only
a bounded phase, allow-listed code and safe request count; messages, stacks, child
stdout/stderr and credential fields are never forwarded. Failure returns a nonzero
exit without rethrowing a raw error. Error codes are captured once under a guarded read;
diagnostic callbacks and output failures cannot interrupt subsequent cleanup.
The process-fault tests exercise missing binaries,
permissions, real owned reader shutdown and primary/cleanup/startup canaries without
starting PostgreSQL or a provider.
It retains its synthetic canonical DB records as evidence; isolate the test target.

The fixture creates in-memory synthetic Ed25519 assertions for the two service
hops. CP verifies the actual scoped Adea signature, issuer, audience, principal,
expiry and workspace. Adea verifies the separate private-product assertion and
holds current original-actor/profile/audience authorization during disclosure.
The DB actor is distinct from transport, admission and model-lease principals.
No deployment credential, signing key, account, scope or grant is configured.

The child starts in the owning CP checkout with plain pinned Bun and its unchanged
TS configuration; it does not inherit the consumer's React server loader options.
Private stdin controls expose evidence, drain and close. SDK timeouts remain five
seconds; host startup and native drain remain bounded at thirty seconds.

## Assertions and retained qualification

The fixture requires preparation with zero physical sends, a declared asynchronous
`starting` or `running` state with canonical dispatch/session IDs, natural terminal
completion, actual current-publication authority, and one exact UTF-8 timeline append
including the trailing newline. Replay must preserve the message ID and all seven
execution/attempt/session/dispatch/selection/revision/preparation pins. Revoking the
original PG actor must deny another status read without a CP read, resend, extra
canonical record, or transcript append.

The recorded run used Adea `fbed2d3e2fb7e3c75c590696f45923b202f6b661` and CP
`c792377f1faf9be39103b3657701e41fc69147f5` (tree
`3210fe80124e93f4ad26ea848719201fc98f6d69`). Public candidates were SDK 1.15.0,
contracts 1.17.0 and runtime-SDK 1.14.0. It passed with one scripted physical send,
722 current product reads, two publication checks and stable replay. Canonical
namespace counts were commands/executions/attempts/budgets = 1 each, usage = 5;
that last count is **not** a model-usage-only count.

Preserved failures remain separate: the first fixture response used incompatible
contract version 1; CP `09dcafea` could not resolve the root launcher dependency;
the first `c792377f` consumer assertion incorrectly required immediate `running`
instead of declared `starting`. The corrected fixture changed no production guard.
The historical CP native timeout's timing cause remains unproven, and this one
connected run does not establish a complete native suite or restart qualification.

## Acceptance gaps

- **Registry adoption:** candidate tarball installation is not an automatic release
  or adoption of supported registry versions in Adea's product manifests.
- **Explicit selection parity:** this factory proof uses the server's retained lead
  default. It does not qualify a UI-selected override through every production port.
- **User-ready journey:** this is a programmatic product/runtime proof. It does not
  qualify the complete mounted user flow, provider setup, payer interaction, natural
  cancellation, approval/child-result timeline, or direct-session experience.
- **Deployment and live authority:** account, vault, payer, readiness and provider
  response ports are disclosed synthetic/scripted fixtures. The HTTPS-semantic CP
  reader bridges to the owned loopback handler; TLS, live provider/account, device,
  restart, paid work and production activation remain unqualified.

Keep F1/U1/U2 and live acceptance open until their full criteria have independent
current-head evidence. This fixture is evidence for its bounded code path only.
