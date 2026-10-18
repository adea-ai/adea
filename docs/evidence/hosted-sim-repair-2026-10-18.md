# Hosted Sim rendering repair qualification

This follow-up supersedes the rendering/CSP hold in the
[parent-save qualification](hosted-sim-parent-save-local-2026-10-17.md).

## Ownership and authorization

Both existing owned worktrees were clean at admission. Adea #1448 began at
`ae4a7b979db72ba90384e70a6fe94b62c9bff6f9`; private AgentSim #111 began at
`37d73db0374322ad697f637fcbdb9794054736b7` and now publishes coverage regression
commit `80c82e3c87397c4edda1102d82a9e0f46211a6c7`. Both remote heads and auto-merge OFF
were verified before publication. Root retains readiness and merge.

Main `b23ddb1d217537b20480291005f8549e17d55be0` was reconciled by normal merge
`d5a01206f69efba7ebc073963a56f71efb849287`. The merged themes scanner repair is
unchanged from main; no second implementation was added. Sim character routing
and the reserved #1450 bridge source are preserved.

The user explicitly approved the isolated document policy repair on 2026-10-18.
Commit `264f7240498d0abeedcd90b324d6c19d2d6437b2` changes only the Sim document's
connection directive to `connect-src 'self' blob:`. Every other directive is
fixed by an exact-policy regression; app API responses acquire no CSP, and
anonymous asset requests remain refused before private reads. That test failed
before the repair and passes afterward.

No live deployment, credentials/access, production composition, hostname/DNS,
release, or broader security-policy changes are authorized or performed.

## Actual built-client rendering and persistence

The rebuilt production desktop SPA is served with explicit disposable API,
desktop bridge, entitlement and storage fixtures. The fresh private 0.14.10
export is built from private source commit `37d73db0374322ad697f637fcbdb9794054736b7` and served only on a separate loopback
cookie host. External network routing remains blocked.

`check-hosted-sim-desktop-save.ts` now also waits for the existing canvas and
scene-ready signals. It passes the complete journey:

1. Anonymous private runtime access is refused without a storage read.
2. The character scene becomes ready, edits A are submitted, and delivery of
   the request is held while edits B are made in the actual designer controls.
3. Acknowledgement commits A but preserves B as dirty without closing.
4. Saving B returns to HQ; the HQ scene becomes ready.
5. HQ reopens the character designer; parent reload restores the same
   155-character serialized selection in the new launch.
6. Closing, opening Room designer from HQ, and returning to HQ all reach ready
   scenes and preserve that selection.
7. The unchanged final zero-error assertion passes: seven local fixture grants,
   219 private asset reads, **zero rendering errors**. No CSP bypass or error
   filtering is used.

A local screenshot was visually checked: the textured HQ floor, greenery and
character render within the actual app shell. Private pixels and export files
remain local and are not committed or uploaded.

The separate actual-client unavailable/offline command also passes with the real
Chat/Dev screens and zero offline Sim grants. These local fixtures are not live
entitlement, native authority, or offline cloud-execution evidence.

## Qualification repairs and checks

The first frozen install retained an obsolete themes 0.10.6 store link from this
worktree's earlier dependency tree. The corrected scanner correctly refused it;
the lockfile resolves only 0.10.10. The old task-local dependency directory was
preserved outside the checkout and a clean frozen install rebuilt the links.
The scanner and its regression now pass without changing their assertions.

The broad run also exposed a fixture race in boot diagnostics: a Bun process
that is intended to exit immediately was still starting when its 600 ms
observation window ended. The fixture now observes the actual child's exit
before handing the real handle to the seam. The 600 ms readiness window,
30-second test limit, every existing exit/journal assertion, and production
behavior are unchanged. All ten diagnostic tests pass after that repair.

Coverage configuration had a separate enforcement defect: singular `line` and
`function` keys are ignored by Bun 1.4.3. A disposable fixture confirmed exit 0
at 50% functions / 100% lines under the old keys, versus exit 1 under documented
`lines`/`functions`. Both owned repositories now retain the intended 0.8 values
under the supported keys, with a real-runner regression and a passing 100%
control. This strengthens enforcement rather than lowering the goal. The
initial broad coverage run passed 1,302 tests but measured 74.15% functions /
86.71% lines, so its old exit 0 did not establish the intended function goal.

Adea uses its pinned Node 24.21.0 and Bun 1.4.3; private AgentSim uses its pinned
Node 24.22.0 and Bun 1.4.3. Executed checks:

- Clean `bun install --frozen-lockfile`: passes, unchanged lockfile.
- Focused CSP, scanner and documentation checks: 14 pass.
- Full `bun run test:unit`: the package graph passes 32/32 tasks, including
  1,620 desktop tests and 794 web tests (15 database-dependent web skips).
  Its separate coverage phase passes 1,303 tests / zero test failures but exits
  1 at 74.15% functions / 86.71% lines under the now-enforced 80% goals.
  The aggregate command therefore remains failed. The initial boot fixture
  race is repaired; this remaining failure is shared coverage, not rendering.
- Full `bun run build`: 17/17 tasks pass.
- Full `bun run typecheck`: 33/33 tasks pass.
- Full `bun run lint`: 19/19 tasks plus root Oxlint pass, zero warnings/errors.
- Full formatting and Adea doctor pass.
- Private build/type/lint/format and all 25 unit tasks pass at `80c82e3`: 95
  package tests plus 36 script tests. Boundary/export checks also pass at
  `37d73db`; the follow-up changes only coverage configuration, its regression
  and documentation. No private runtime source repair was needed.
- Private doctor retains its existing Code Foundry 1.48.3 caller-regex failure:
  it recognizes `validation.yml`/`validation-no-codeql.yml`, while this repository
  deliberately uses `validation-billing.yml`. Billing policy and permissions
  were not changed to evade the check.
- Desktop client output: 311 files, 4,144,816 bytes, zero Sim payload files.

The held Vite qualification head remains
`cdefde7c8aaeb8aa0d27e1976872146f37bc628d`; its original dirty diff retains
SHA-256 `305e8df7aaed980a47e37eaebc19ee6dc2fbdf67de51a236af2b765414b26eb8`.

## Remaining authority boundary

Production still returns `not_configured` without the approved entitlement
source and durable store/host composition. The
[production proposal](../plans/hosted-sim-production-composition.md) distinguishes
that separate live authority from this completed isolated rendering repair.
The shared function-coverage deficit remains a qualification blocker: it is
concentrated in DB/schema and other shared sources outside the existing Sim
ownership. Scope/owner coordination is required before changing those tests;
no coverage exclusion or lower goal was introduced. Root's exact-head review
and applicable passing validation still gate merge.

## Repeatability follow-up

The original completed journey above is a real zero-error result. Subsequent
runs at Adea `b2318660221d0a5ac23684b4f16de5496ae1f48e` with a fresh private
`80c82e3c87397c4edda1102d82a9e0f46211a6c7` export also completed with seven
grants, 215–216 reads and zero rendering errors. The desktop client was rebuilt
again at this head; later private commits change tests and script seams only.

However, repeated runs intermittently time out waiting for the final HQ
Character control after returning from Room designer. One failed run recorded
zero console errors; other failed runs recorded one GLTF blob texture load
error. The original CSP block flood is repaired, but these repeats do not yet
establish reliable rendering completion. No error is filtered and no assertion
or timeout is relaxed. The script now records each completed phase and captures
frame URLs, lifecycle messages, root DOM and control visibility/geometry on
failure. In a captured failure the final frame received `host.launch:hq`,
reported running and contained a canvas and HQ HUD; investigation remains open.

Private behavior tests have advanced independently beyond the initial coverage
receipt. Its new full coverage command uses Solid's browser condition and the
real disposable private-pack export contract. All 185 tests pass, aggregate
97.10% functions / 97.68% lines; every measured file meets the unchanged 80%
goals except `scripts/orch-toolchain.mjs` (90.00% functions / 76.42% lines).
Toolchain source remains unchanged pending overlap coordination. Root's shared
Adea DB/schema coverage ownership coordination also remains pending.

## Catalog teardown diagnosis and private qualification

A synchronous test-only console trace, preserving every original call and the
strict error assertion, identifies the remaining GLTF error as Room designer
after `pagehide`. Private source `ee28724caab0856697eccb8b4def862f139ad0f9`
repairs the separate shared catalog loader: embedded GLB buffer-view images use
Three's native document-image decoder, while external and specialized image
backends remain unchanged. A real GLTF-parser controlled fixture reproduces
the default missing-map/loading-error behavior and verifies repaired map
retention, genuine error reporting and external bitmap decoding. The scene
bitmap-loader cancellation repair remains in place.

Private full unit passes 26/26 tasks plus 40 scripts. Full per-file coverage
passes 190 tests / 3,049 assertions, retaining the 80% goals for every measured
file. Types/lint/format/export pass. Real ImageBitmapLoader controlled tests also
verify abort, decoding settlement, genuine failures and balanced accounting;
global fixtures are protected by `finally`. Strict actual-client repeats on the
fresh catalog export are in progress at this publication.

A concurrent writer normally merged main's reviewed #1403 checkpoint changes
into the existing Adea draft (`b586bfcc`). The diagnostic commit `cd96e1f64` was
preserved by normal merge `14f7289479e0c7cd568621260d43f0edbb5fa3ba`; no force
push or overlapping edit occurred. After required local dependency files went
missing, the old owned installation was preserved and frozen install restored
it; full typecheck and the normal commit hook pass again. A separate fresh
private export replaces the incomplete earlier local export for further tests.

## Native browsing-context replacement candidate

After private `341e616`, two strict actual-built-client journeys passed with zero
rendering errors; a third reproduced blank HQ with zero errors. Its native DOM
journal proves the same iframe was removed/reinserted repeatedly, loaded a second
time, and posted another ready after running. The old controller correctly
refused that replay and did not reuse the consumed grant.

The app wrapper now allows one fresh component/nonce/grant after a second native
load of the same iframe. A repeated reload presents the existing unavailable
notice with explicit retry. Retired listeners are removed. Valid configuration
is reused on this retry, avoiding a loading-status insertion that moved the new
frame again; failed configuration still refetches. The shared bridge/controller
implementation is unchanged. Bootstrap configuration reads now abort on pagehide;
genuine errors remain observable and listener cleanup has focused tests.

The controlled real-browser regression removes/reinserts the actual iframe,
checks one fresh grant and a changed frame address, repeats the native reload,
checks the manual retry gate and fresh grant, then completes the existing strict
save/reload/designer journey. Earlier candidates passed automatic recovery but
exposed extra grants on retry and two unhandled fetch errors. Current types
33/33 and lint 19/19 pass; the latest browser repeat is still pending. No error
filter, ready-replay relaxation, spent-code reuse or threshold change was added.

### Async detach and bootstrap qualification

Root's review identified that removing a listener also lost its closure-local load
count. Load history now lives in a WeakMap, while the strong listener map contains
only current descendants. The real-browser async variant detaches across a timer
turn (and therefore a MutationObserver delivery), then reinserts the same element.
It verifies a changed frame address and exactly one fresh grant, a second reload
requiring explicit retry, and a fresh grant after that retry.

Pagehide/closed cancellation alone did not eliminate discarded-document bootstrap
errors. Configuration work now starts only after native load handling and the
next paint; an abandoned document starts no configuration read. Five focused tests
retain genuine-error propagation and cover cleanup, disposal and load/paint order.

The complete async native-move journey passed with the real built client and
private `341e616` export: 10 grants, 281 authorized asset reads, unchanged
155-character saved value, **zero rendering errors**. All original delayed-ACK,
close/reopen, parent-reload and Room-to-HQ assertions remain. Types 33/33 and lint
19/19 plus root pass. Synchronous and ordinary repeats remain to be recorded;
this single successful async run is not yet repeated-journey clearance.

### Repeated journeys and background bootstrap

At runtime commit `2cbbb1f`, four consecutive strict journeys passed: async native
move (10 grants/281 asset reads), synchronous move (9/280), ordinary repeat one
(7/235), and ordinary repeat two (7/236). Every run preserved the same
155-character value and recorded zero rendering errors. The final HQ screenshot
was inspected locally: the scene, character and designer controls render.

Root identified that background documents may suspend paints. Preparation now
also uses the next task after native load as a fallback; completion is idempotent
and cancels both scheduled callbacks. The new regression never fires rAF, proves
the fallback completes, and proves disposal before fallback starts no read even
if a stale callback is invoked. Genuine configuration failure remains observable.
Six focused bootstrap tests / 29 assertions pass. Types 33/33, lint 19/19 plus
root, and full formatting pass. The updated complete async-move journey passes
with 9 grants, 277 authorized reads and zero rendering errors.

The local unsigned stable-format archive for the current client has 821 entries,
123,871,920 bytes and SHA-256
`cf5bdf757ac44b381307df4e195950a3e560481673137643b31181949d154188`.
The installed 311-file client matches the built client byte-for-byte
(4,149,362 bytes). Hash comparison against all 1,882 private export files finds
only four identical JSON scene manifests, each verified against its tracked
`packages/spatial/data/{home,work}/{editor-overrides,props}.json` source. There
are zero private engine/runtime/binary-asset matches. No private output or
screenshot is uploaded. Reconciliation and archive refresh for newer main remain
separate receipts; these numbers are not relabeled as a later package.
