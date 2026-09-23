# M12 #472 real-OS computer-use acceptance evidence — 2026-09-22

This record captures the real-OS macOS acceptance work for #472's remaining
gates (the issue's own rule: fixture-only work cannot close it). It was
produced on the isolated checkout `feat/m12-472-real-os` (worktree of main @
`d4062697`, v0.45.0 + M13/M12 integration) on a macOS ARM64 host with the
built Electrobun toolchain. It is evidence for the open real-OS acceptance on
#472 — the packaged TCC-denied behavior, revocation timing, and takeover UX —
not a milestone-closure claim.

## Command and build

```text
bun install --frozen-lockfile
bun run test:packaged
```

The lane built the DEV macOS app at
`apps/desktop/shell/build/dev-macos-arm64/Adea-dev.app` (version `0.1.0`,
channel `dev`). Lane results: supervision smoke **pass**, terminal
replay/restart/resync **pass**, worktree containment **pass**, transport
defect probe warning (defect no longer reproduces — expected, by design),
browser/device matrix **failed** (pre-existing, environmental; see
"Packaged-lane failures outside this change" below).

The new computer-use proof then ran against that bundle:

```text
bun apps/desktop/shell/scripts/packaged-computeruse-tcc.ts \
  --app-bundle apps/desktop/shell/build/dev-macos-arm64/Adea-dev.app \
  --artifact artifacts/packaged/computeruse-tcc.json
```

Final runs: `PACKAGED-COMPUTERUSE-TCC PASS`, 25 checks, 0 failed, ~13 s —
two consecutive clean passes (the last at 2026-09-22T20:07:04Z–20:07:17Z),
both exercising the granted branch end-to-end (consent issued, lane
activated, single-use mint, takeover, late mint refused, Escape release).
Earlier runs of the same script exercised the pending branch: the same checks
pass with the typed `not_determined` refusals instead (see the run table
below). The JSON artifact records booleans and typed states only — no
secrets; the handshake secret stays in process memory and is never written.

### Probe-deadline finding (recorded, not hidden)

The shipped probe deadline is 3 s (`PROBE_TIMEOUT_MS`). On this host, raw
probe latency measured 1.0–3.1 s round-to-round under post-build load — right
at that deadline — so the shipped probes honestly classified
`not_determined` ("the macOS consent prompt is still open") on some rounds
and `granted` on others. The evidence service therefore takes a 10 s deadline
(a documented seam parameter): it still classifies a genuinely open prompt as
`not_determined`, but no longer conflates host load with TCC state. The
artifact records both observations (`proofProcess` and
`proofProcessShippedDeadline`), and every decision check uses the
extended-deadline service.

## Fresh-TCC-identity proof (what makes first-run observable)

The rebuilt bundle's code identity was observed with `codesign -dvv`:
`Signature=adhoc`, `flags=0x20002(adhoc,linker-signed)`. The dev bundle has no
stable designated requirement and no sealed resources, so TCC has no stable
identity to bind a grant to — every rebuild is a first-run app for the
Automation/Accessibility services. That is the mechanism this proof relies on;
it is recorded, not assumed.

## Real TCC probe observations (typed states, two contexts)

The production #471 probes (`/usr/bin/osascript` fixed argv, 3 s deadline,
production classifier) ran in two execution contexts: the proof process and a
child on the bundle's own packaged Bun runtime. Across consecutive runs the
host honestly exhibited both pending and granted states:

| Run                   | Context                      | accessibility    | automation_apple_events | screen_recording / notifications / microphone |
| --------------------- | ---------------------------- | ---------------- | ----------------------- | --------------------------------------------- |
| run1                  | proof process                | `granted`        | `granted`               | `unavailable` (no probe in this lane)         |
| run2                  | proof process                | `granted`        | `granted`               | `unavailable`                                 |
| run3                  | proof process                | `not_determined` | `granted`               | `unavailable`                                 |
| run4                  | proof process + bundle child | `not_determined` | `granted`               | `unavailable`                                 |
| run5 (final artifact) | proof process + bundle child | `granted`        | `granted`               | `unavailable`                                 |

`not_determined` is the bounded probe's "the macOS consent prompt is still
open" classification — a genuine first-run/pending reading on a fresh
identity, and (per the deadline finding above) also the honest reading when
probe latency meets the 3 s deadline on a loaded host. The `granted` readings
are the launching toolchain's Automation grants (attribution to the app
bundle versus the launching toolchain is NOT provable headlessly; both
contexts are recorded verbatim in the artifact, including the `attribution`
field stating exactly that).

## (a) Every operation returns the typed permission state

Through the production registrar and the signed M10 gate against the real
snapshot:

- `dev.computeruse.capabilities` returned the typed 3-row report every time —
  `input` mirrored the live accessibility probe exactly (`granted`→`available`
  in run1/run2/run5, `not_determined`→`not_determined` in run3/run4),
  `capture` and `ax_tree` stayed `unavailable` naming their missing pieces.
  Never a silent empty success.
- `dev.computeruse.consent` with an owner confirmation: ISSUED when the probe
  proved granted (final artifact: single-use record bound to the next
  generation, lane activated to `granted`); REFUSED with `permission_denied`
  and the pending-permission message when the probe answered
  `not_determined` (run3/run4: "the accessibility consent prompt is still
  pending; answer it, then re-check on the permissions page").
- `dev.computeruse.input` without a live consent record refused typed
  (`not_found`) every time — fail-closed.
- `dev.computeruse.attach` minted a typed read-direction
  `desktop-frames-v1` grant (the capture stream itself closes `incompatible`
  at the gateway until the native helper lands).
- `dev.computeruse.laneCreate` / `lanes` behaved typed through the gate.

The denial-path matrix (real gate, real classifier, the host's own refusal
text `-1719` fed through the #471 runner seam) proved the `denied` branch:
consent refuses with `permission_denied` and the `open_settings` remediation.
Real System Settings TCC toggling is not scriptable; that stands in for it
and is recorded as such.

## (b) Permissions-page guidance

The refusal objects carry the exact page guidance: `open_settings` →
`x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`
for denied accessibility, and `request_permission` for the pending state. The
frozen pane table names the ScreenCapture pane
(`...?Privacy_ScreenCapture`) for screen-recording guidance. Deep links live
only in `SETTINGS_PANES`; no client string reaches argv.

## (c) Grant-then-revoke within one interaction

Two layers:

- Packaged lane, real gate (final artifact): takeover after a live input
  grant revokes the consent records synchronously, and the FIRST subsequent
  mint interaction is refused (mint ok → takeover suspends agent input
  instantly → late mint refused typed → Escape
  (`dev.computeruse.release`) returned authority to the agent with a fresh
  generation).
- Packaged lane, #471 seam (the pending-branch runs): an issued consent whose
  permission digest moved refuses the next verification after the freshness
  window — observed refusal: "the accessibility grant behind this consent
  moved".
- Deterministic pins (injected clock, `apps/desktop/tests/
dev-runtime-computeruse.test.ts`): takeover and kill-switch refusals land
  at the very next admitted frame with ZERO clock advance owed; a TCC flip to
  denied refuses the first frame after the 10 000 ms freshness window and
  every frame after it; past the 60-second consent TTL even a restored grant
  cannot resurrect admission.

## Revocation timing numbers

- Explicit revocation (takeover / laneClose): synchronous — the next
  interaction is refused with no clock advance (injected-clock pins; the
  packaged lane observed the same ordering live).
- TCC-level revocation (permission state moves): first admission after the
  10 000 ms freshness window is refused, then every subsequent admission
  (10 001 ms and 10 002 ms ticks pinned; packaged seam observed after the
  bounded 10 500 ms wait).
- Engine-level TCC refusal during injection kills the lane immediately
  (existing pin: lane → `crashed`, consent dropped).

## Takeover UX pins

Pinned in `apps/desktop/tests/dev-runtime-computeruse.test.ts` (now 41 tests,
all passing): takeover suspends agent input instantly and fences old
generations; the human principal is admitted at the takeover generation while
agent input is not; `dev.computeruse.release` (the Escape path) returns
authority through the provider and agent input waits for a fresh owner
confirmation; stale-generation input is inert at the ledger; close is the
idempotent kill switch; session teardown closes every lane.

## Discipline

The packaged proof never performs real input: the engine seam carries a
recording stand-in for the whole run (final check: 0 events injected), and no
frame is ever admitted with a live host engine. No System Settings toggle, no
Settings deep link is opened (`settingsUrl` is read, `openSettings` is not
called).

## Packaged-lane failures outside this change

`bun run test:packaged` currently fails at the browser/device matrix on this
host, for reasons untouched by this branch (this change adds one test file and
one standalone packaged script; neither is in the packaged lane's dependency
graph). PROOF D of that matrix reports Bun.WebView as AVAILABLE on this Bun
(1.4.0), so the matrix's PROOF B admitted-navigation probe — written to expect
typed `capability_unavailable` from an absent engine — now reaches the real
engine lane, which crashes (`crash_loop: lane engine crashed during
navigation`). This is a real finding for the browser lane on Bun 1.4 hosts,
recorded here for whoever owns `packaged-browser-matrix.ts`; fixing it was out
of scope for #472 file ownership.

## Remaining gates

- The TCC grant-then-revoke flip at the System Settings level (real
  mouse-driven grant/revoke) remains a manual owner action; this run proves
  everything scriptable around it and records the rest honestly.
- Capture/AX-tree stay typed-unavailable until the native screen-recording
  helper and an authorized AX bridge land (#542's packaged gates).
- GUI attribution of a probe (app bundle vs launching toolchain) is not
  provable headlessly; both contexts are recorded verbatim.
