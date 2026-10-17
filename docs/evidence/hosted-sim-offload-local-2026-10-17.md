# Hosted Sim offload: local qualification, 2026-10-17

Status: local implementation and payload exclusion proven; end-to-end product
completion and readiness remain blocked. No production deployment or access
change is included. Root owns personal review, readiness, and merge.

## Source and ownership

- PR: [Adea #1448](https://github.com/adea-ai/adea/pull/1448), branch
  `feat/hosted-sim-offload`, draft, auto-merge off.
- Base: `230df82acf1da8e36079b05c45369cb05662eb11`.
- Payload removal: `79f80ce00822a2229a6ec7a41d218da01ba99c91`.
- App/private-host integration: `c1e4b2d43f78cefd61210e56d60d18965c7f7f8c`.
- Legacy responder refusal: `7a6383d0d50a663424059386161d9cfa29f5f870`.
- Normalized-path/CLI repair: `fd021c14ba3ed3b587928f1f10f19a8fb8fd6bd9`.
- Offline UI and bridge proposal: `86ba6d06b5e4299affe19485bed567e65cbd1328`.
- Additional actual-client/expiry qualification and fixtures:
  `19e1ffa143f712a08fb9cffc214b8e1693939ecc`.

The native artifact below was built from client/shell source at `86ba6d06b`.
The `19e1ffa14` production-source delta changes only the separately hosted
asset gate's invalid-clock refusal; it changes no bundled client/shell code.
The remaining delta is qualification/tests/documentation. All completed
checked commits were pushed directly and their remote SHAs verified.

Root's [review update](https://github.com/adea-ai/adea/pull/1448#pullrequestreview-5559119274)
closes the encoded-path finding. Character transport and acknowledged Save
remain open. The retained bridge/component owner has the three bridge gaps;
its acknowledgment/contract implementation is not confirmed by this evidence.
The [app-side proposal](../plans/hosted-sim-bridge-follow-up.md) is prepared
without modifying its reserved files.

The held AgentSim branch stays at
`cdefde7c8aaeb8aa0d27e1976872146f37bc628d`, with the original three dirty files
and unchanged diff digest
`305e8df7aaed980a47e37eaebc19ee6dc2fbdf67de51a236af2b765414b26eb8`.
No private repository or asset source was changed. No toolchain/version pins,
lockfiles, Vite configuration, or orchestration graph were changed.

## Build, import, content and installed-artifact proof

Final build tools: Bun **1.4.3**, Node **24.21.0**. Earlier validation inherited
Node 24.18.0; the final client/native build and serial typecheck use both exact
pins. The local private export is **0.13.4**, an existing export, not a claim of
current release compatibility or deployment.

| Check                                    | Result                                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Built client                             | 305 files, 4,034,390 bytes, zero Sim payload files                                                           |
| Inner installed archive                  | 815 entries, zero Sim payload files                                                                          |
| Installed client versus build            | File paths and SHA-256 content maps are identical                                                            |
| Rendered module manifest                 | 1,111 rendered modules; zero private engine/scene/Three imports; the generic hosted bridge/component remains |
| Private runtime input fingerprints       | 1,873 files: top-level runtime JS/CSS and non-JSON models/worlds/decoders                                    |
| Fingerprints versus installed client     | Zero matching private runtime digests, independent of filenames                                              |
| Fingerprints versus entire installed app | 562 regular files compared; zero matching private runtime digests                                            |
| Compressed inner installed archive       | 123,820,607 bytes                                                                                            |
| Inner archive SHA-256                    | `29fb58d20f5ade0e9f264928aded3d3da48d42cfbc9dc97721f04f9fb3503007`                                           |

The native build used `bunx --bun electrobun build --env=stable` locally.
This creates an unsigned test artifact; it does not publish a release or
install the app. The inner archive was listed, extracted into a disposable
location, checked with `check-desktop-sim-payload.mjs --archive`, and its
installed client checked with `--client`. Public protocol scene manifests
and shared published UI content remain allowed.

For a negative control, the existing private export was appended to a copy
of the built client using the former staging layout. That reconstruction is
**not a historical release**. It contains 2,187 files and 323,386,865 bytes,
including 319,352,475 engine bytes. The corrected CLI refuses it. This measures
raw engine exclusion, not a historical compressed-download saving. Content
fingerprints also detect byte-identical files when renamed; the rendered
module manifest separately checks compilation imports.

## Functional qualification

- Joined local HTTP tests cover origin admission, bounded JSON, absent
  authority, single-use code exchange/replay, cookie attributes, surface
  binding, session expiry, and refusal before private reads on an invalid clock.
- Frame tests cover foreign/duplicate messages, denied exchange, and disposal
  during a pending mount.
- The actual `HostedSimEntry`, hosted component, frame bootstrap and merged
  issuer/exchange run over separate disposable cookie hosts. Both the small
  engine fixture and the existing private export mount HQ and both direct
  designer entries in Chromium. The final private-export run uses five fresh
  grants and observes 106 authorized asset reads; counts are observations, not
  performance budgets. It refuses an expired session before a storage read,
  obtains a fresh same-surface launch, shows offline without requesting a
  grant, and launches freshly after reconnect. No page errors occur.
- The partitioned Sim cookie is Secure and HttpOnly, and does not reach Adea
  API requests. Anonymous assets are refused before storage is read.
- `bun scripts/check-hosted-sim-desktop-client.ts` serves the **actual built
  desktop UI** with disposable API/bridge fixtures and external network blocked.
  Real Chat/Dev screens remain navigable while Sim is unavailable and offline;
  no grant is requested while offline. This is UI independence proof, not native
  authorization or offline cloud execution. The small joined frame harness's
  Chat/Dev placeholders alone are not used to establish this result.
- Existing `supervision-smoke.ts --app-bundle` passes proofs 0–6 against the
  explicitly extracted inner app and its bundled sidecar. Its managed-Pi lane
  uses the existing smoke fixture and is not a production Pi installation proof.

## Validation and failures retained

Commands use the exact toolchain above; local listeners and native test
processes were disposable. No production resource was exercised.

| Command/lane                                                                 | Outcome                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code-foundry doctor`                                                        | Pass                                                                                                                                                                                                        |
| `bun run format:check`                                                       | Pass                                                                                                                                                                                                        |
| `bun run lint`                                                               | Pass, zero warnings/errors                                                                                                                                                                                  |
| `bun run typecheck`                                                          | Pass serially, 33/33 tasks; an earlier concurrent run collided on generated declarations and was rerun without source workarounds                                                                           |
| Web native unit/source-contract lane                                         | 766 pass, 15 database-gated skips, zero failures                                                                                                                                                            |
| Focused final HTTP/frame, release/auth and path tests                        | 49 pass                                                                                                                                                                                                     |
| `bun test scripts/desktop-sim-payload.test.ts scripts/docs-boundary.test.ts` | 9 pass                                                                                                                                                                                                      |
| Joined browser acceptance, engine fixture                                    | Pass, including expiry/relaunch                                                                                                                                                                             |
| Joined browser acceptance, private export                                    | Pass, including expiry/relaunch                                                                                                                                                                             |
| `bun scripts/check-hosted-sim-desktop-client.ts`                             | Pass against actual built UI with explicit fixtures                                                                                                                                                         |
| Client and unsigned native build; inner payload gate                         | Pass                                                                                                                                                                                                        |
| Explicit inner-app supervision smoke                                         | Pass, proofs 0–6                                                                                                                                                                                            |
| `bun run test:unit`                                                          | Fails: desktop package has 1,457 pass, 4 skips, one supervision smoke failure because autodetection selects the outer installer, which has no directly installed sidecar; the explicit inner-app run passes |
| `bun run test:coverage`                                                      | Fails: 1,296 pass, two failures—installed themes scan and preview-refusal timeout; 86.73% lines / 74.15% functions, against configured 80% thresholds                                                       |
| `bun test scripts/cloudflare-preview-workflow.test.ts`                       | Isolated rerun passes 14 tests; the coverage-run case timed out at five seconds                                                                                                                             |

The themes guard skips Bun store entries whose directory entry is a symlink,
so it reports zero installed copies even though the frozen install contains
`@adea-ai/themes` 0.10.6. This belongs with the separate toolchain/cache owner;
no pin or scanner workaround is included here. Broad command failures and
coverage thresholds are not hidden or waived. No coverage threshold, test gate,
or hook was bypassed.

No live database integration, live hosted rollout, current-export release
qualification, or Firefox/WebKit matrix was performed. The 15 web-suite skips
require an isolated database, which was not configured. No release, production
deployment, DNS/binding change, credentials/access change, paid upgrade, or
private-asset upload occurred.

## Remaining gates

1. **Pending authority decision:** production `sim-api.ts` has no installed
   authoritative issuer. A hostname alone still returns `not_configured`.
   Select the approved existing entitlement authority and compose the existing
   authenticated principal/workspace checks with durable atomic code/session
   storage. Disposable fixture entitlement/storage is not a production substitute.
2. **Pending retained owner:** bounded serialized-character transport, typed
   HQ designer navigation, and acknowledged parent Save/persistence. The actual
   serializer produces a 157-character pipe-delimited configuration rejected by
   the current bridge. Save still updates only the disposable child URL.
   Save/close/reopen and parent-reload persistence are therefore unqualified.
3. **Pending explicit live authorization:** name the private hosting/storage
   targets and approve specific deployment, hostname/DNS, binding, or access
   actions if needed. None was attempted. Existing published desktop releases
   are unaffected by this draft.
4. **Pending validation/review:** resolve the broad test/coverage findings and
   obtain root's complete source review before readiness or merge.
