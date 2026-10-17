# Hosted Sim parent persistence and package qualification

This follow-up supersedes the bridge/persistence and supervision gaps in the
[earlier local evidence](hosted-sim-offload-local-2026-10-17.md). It is local
evidence with disposable authority/storage, not a production rollout.

## Exact implementation heads

- Adea #1448: `ac591c36bcd03a6954789eb22350580acb581825`.
- Private AgentSim #111: `112c7b7e25b87c59e26b6487413083d49fb9957c`.
- Reviewed bridge dependency #1450:
  `4d247f60363e724a023c83448bc94febc71bd476`. The reserved source paths remain
  byte-identical to that dependency; they were integrated through a normal merge.

Both implementation PRs are drafts with auto-merge off. Root retains review,
readiness, and merge. The held Vite qualification branch remains at
`cdefde7c8aaeb8aa0d27e1976872146f37bc628d`; its original three-file worktree diff
retains SHA-256 `305e8df7aaed980a47e37eaebc19ee6dc2fbdf67de51a236af2b765414b26eb8`.

## Actual desktop client and private designer

`ADEA_SIM_TEST_EXPORT=/path/to/private/export bun scripts/check-hosted-sim-desktop-save.ts`
serves the actual production desktop SPA and a locally rebuilt private 0.14.9
export. The browser uses separate loopback cookie hosts and the real app/frame,
issuer, exchange, and private-read boundaries. Its API/desktop bridge,
entitlement, and stores are explicit local fixtures. Network routing permits only
the two loopback origins; private assets remain on disk.

The joined run at the heads above passed these assertions before its final
rendering-error gate:

1. An anonymous engine request returns 401 without reading private storage.
2. The actual designer edits a character and submits Save & return. A local test
   holds delivery of that save request until the second edit is observed,
   leaving the real UI waiting for host acknowledgement while another edit is made.
3. The first submitted snapshot becomes the parent selection, while newer edits
   remain dirty and the designer stays open. Reset remains enabled.
4. Saving the newer edit acknowledges a different serialized value, closes the
   designer, and returns to HQ.
5. HQ's Character control opens a fresh designer launch. Reloading the parent
   restores the same 155-character serialized value in `host.launch`.
6. Closing the reloaded designer, opening Room designer from HQ, and returning
   to HQ preserve that same character selection and use fresh surface launches.

That run issued seven grants and read 202 private assets. Its final zero-error
assertion **fails**: 423 console errors, all classified as blocked blob texture
fetches or the corresponding GLTF texture errors. The former unsolicited
sibling-origin portal prefetch no longer occurs. The existing
`connect-src 'self'` policy is retained under the no-security-changes instruction.
No CSP bypass or filtered error assertion is used to claim a pass.

The separate `bun scripts/check-hosted-sim-desktop-client.ts` run passes with the
actual built Chat and Dev screens while Sim is unavailable/offline and issues
zero grants while offline. This uses a synthetic desktop bridge and does not
prove native authorization or offline cloud execution.

## Fresh local desktop artifact

The client and native build use Bun 1.4.3 / Node 24.21.0. The private export uses
its unchanged mise Bun 1.4.2 / Node 24.21.0. The stable-format artifact is local
and unsigned; no release, installation, or publication is performed.

| Measurement                           | Result                                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| Installed client                      | 306 files; 4,038,547 bytes; zero Sim payload files                                      |
| Inner installed archive               | 816 entries; 123,823,917 bytes                                                          |
| Inner archive SHA-256                 | `d077b3e918a84fcaf4e031e1fe990beebd30e585fab13a53583a1ce015960b61`                      |
| Built versus installed client         | Byte-identical file names and SHA-256 values                                            |
| Rendered client module graph          | 1,113 modules; zero private engine/Three.js runtime imports                             |
| Whole installed app digest comparison | 563 regular files compared with 1,873 private runtime candidates; zero matching digests |
| Excluded private export               | 319,379,946 bytes, measured on disk                                                     |
| Counterfactual client plus export     | 323,418,493 bytes; arithmetic reconstruction, not a measured historical release         |
| Legacy mount negative control         | A minimal stale engine-path canary is rejected by the CLI                               |

The first comparison correctly refused to equate the new client with an older
stable artifact. Rebuilding the stable-format archive produced the matching
artifact above. The supervision smoke then extracted that fresh outer app into
a disposable directory and passed all seven existing manifest/digest/runtime
and real-process proofs. Its auto-detection regression test also passes.

## Validation and remaining gates

- Affected Sim/payload coverage: 202 tests pass; 81.38% functions and 83.47%
  lines, with the existing 80% thresholds unchanged. The parent-route helper has
  100% function/line coverage; archive checker function coverage increased to 100%.
- Private engine: build (13 tasks), type check (23 tasks), lint, formatting,
  and test (24 tasks, 95 tests) pass. The delayed-acknowledgement behavior also
  has a component-used save-controller regression and actual UI evidence above.
- Adea lint (19 tasks), formatting, type check (33 tasks), and doctor pass.
- Private doctor reports existing validation-caller drift: it does not reference
  the validation orchestrator. Configuration remains with the tooling owner.
- The broad coverage rerun has 1,299 passing tests and the themes installed-copy
  scanner failure; overall functions 74.27%, lines 86.90%. No threshold or scanner
  workaround is included. The toolchain owner retains that scope.
- `bun run test:unit` completes 30/31 tasks; the desktop package reports 1,464
  pass, one skip, one GitHub-provider timeout, and its subsequent asynchronous
  assertion error. The same provider case passes in isolation (943 ms) without
  changing its 5-second timeout. Supervision passes in the aggregate. The web
  package has 784 pass, 15 database-dependent skips, and zero failures. The
  aggregate remains failed; its coverage phase is not reached. The explicit
  coverage rerun above is separate evidence.

The [production composition proposal](../plans/hosted-sim-production-composition.md)
names the missing entitlement/storage authority and the exact proposed blob
policy addition. Until those decisions and necessary live actions are authorized,
production remains `not_configured`. Rendering, broad validation, and root review
still gate readiness. Local fixtures never imply production entitlement.
