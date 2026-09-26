# Dev View donor source audit

- Status: Proposed planning evidence for acceptance in #394
- Audit date: 2026-09-14
- Tracks: [#394](https://github.com/adea-ai/adea/issues/394), milestone [M12](https://github.com/adea-ai/adea/milestone/23)
- Product authority: the owner's Apple Note **“Adea Dev View”**
- Normative decisions: [ADR 0009](../decisions/0009-dev-view-control-plane.md)
- Exact machine-readable sources: [source manifest](./dev-view-source-manifest.json)
- Normative implementation contract: [Dev Runtime spec](../specs/dev-runtime.md)

This is a source-level audit, not a README comparison. The pinned trees,
manifests, licenses, implementation files, and nearby tests were inspected
read-only. Donor builds were intentionally not installed or run. A path below
is evidence for a behavior, not permission to copy it; the license and reuse
classification remain controlling.

## Decision summary

Adea will combine:

- KiroCrew's information hierarchy;
- Orca's project/worktree/runtime depth;
- Warp's high-level terminal ergonomics, independently reimplemented;
- Terax's file/source-control clarity;
- selected bounded algorithms and state-machine concepts from bb, t3code,
  Zeron, Muxy, and Buzz.

Adea is **reuse-first**. For MIT/Apache donors, implementation agents SHOULD
start from the cited implementation and tests, copy or substantially adapt the
smallest coherent unit, retain proven state transitions and edge-case coverage,
and then layer Adea's authority, limits, and Solid/Bun adapters on top. They
MUST NOT start a novel implementation merely because the donor uses a different
UI or host framework. Framework seams are replaced, while reusable algorithms,
DTOs, reducers, parsers, state machines, and visual composition are preserved
where compatible.

The integrated client remains SolidJS, Bun 1.4, Electrobun 2.0.1 with bundled
CEF, CodeMirror 6, and `@xterm/xterm`. React, Electron, Tauri, GPUI, Rust, and
Swift shells are not imported as runtime dependencies, but their licensed
implementation units are valid translation donors. Every copied or
substantially translated unit is entered in the file-level provenance ledger.

## Reuse classifications

- **Adaptable:** a coherent MIT/Apache implementation unit—including its tests
  and supporting reducers/parsers—SHOULD be copied or substantially translated
  after dependency review, header preservation, and a ledger plus `NOTICE`
  entry. Prefer the complete proven behavior over a novel local replacement;
  keep the unit as small as integration permits, not smaller than correctness.
- **Adapt with host/UI translation:** preserve the donor's proven algorithm,
  state transitions, component composition, and tests while replacing its
  framework or privileged seam with Solid/Bun/M10 contracts. This is reuse,
  not a clean-room rewrite, and requires provenance.
- **Prohibited:** no source, test, asset, generated output, identifier, fixture,
  copy, or close adaptation may enter Adea.

Repository licenses do not sublicense dependencies. Every dependency used by
Adea must be checked at its installed version.

## Pinned donor matrix

| Donor              | Revision                                                                                                                           | License boundary                                                                                                                 | Classification                                               | Adopt                                                                                                                              | Reject or redesign                                                                                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KiroCrew           | [`283e136c0f902e965a535a7c9548c57c7504fed0`](https://github.com/kirodotdev/KiroCrew/tree/283e136c0f902e965a535a7c9548c57c7504fed0) | Apache-2.0 plus upstream [`NOTICE`](https://github.com/kirodotdev/KiroCrew/blob/283e136c0f902e965a535a7c9548c57c7504fed0/NOTICE) | Adapt with UI/host translation and NOTICE                    | Global/contextual navigation, App Library composition, prune-first project scanning, ACP lifecycle, browser transport taxonomy     | React/Electron runtime wrappers, subscription coupling, hidden files/browser flows, font-only fake terminal mode                                                                                      |
| Orca               | [`403b62a8d8fa6e896a93acc4c15405be0f0b7dc7`](https://github.com/stablyai/orca/tree/403b62a8d8fa6e896a93acc4c15405be0f0b7dc7)       | MIT                                                                                                                              | Primary TypeScript implementation donor                      | Worktree proof/trash, terminal history/adoption, write fencing, project hierarchy, browser/device and GitHub units                 | Electron/Zustand coupling, heuristic status, process-local assumptions, unsafe history-path deletion and PID-only port termination                                                                    |
| t3code             | [`77bca8b2d76a1f42552e5eee7d277fcb1160347a`](https://github.com/pingdotgg/t3code/tree/77bca8b2d76a1f42552e5eee7d277fcb1160347a)    | MIT; dependency licenses separate                                                                                                | Adapt interfaces and implementations with hardening          | Bun PTY adapter, previews, ports, annotations, provider/PR DTOs, checkpoint and external-editor contracts                          | String-decoded PTY, shell-text bootstrap, force removal, broad absolute reads, symlink-parent writes, partial cookie import, unsafe configurable usage URL, Ghostty WASM                              |
| Warp               | [`3959ea72141fc0ecd007665029a8058e0e6db0f8`](https://github.com/warpdotdev/warp/tree/3959ea72141fc0ecd007665029a8058e0e6db0f8)     | MIT only for `crates/warpui` and `crates/warpui_core`; all other relevant code, including `crates/warpui_extras`, is AGPL-3.0    | Concept only; relevant source is not an implementation donor | Independently stated requirements: terminal blocks, bottom editor, palette, pane toggles                                           | All source structures, identifiers, schemas, wire formats, tests, fixtures, comments, constants, UI copy, spacing, and close translations from AGPL paths                                             |
| terax-ai           | [`b02a7dcbfe58d22b2352d9618b8ed3199e317a00`](https://github.com/crynta/terax-ai/tree/b02a7dcbfe58d22b2352d9618b8ed3199e317a00)     | Apache-2.0                                                                                                                       | Primary editor/files/source-control UI donor                 | CodeMirror composition, Files/Source Control pairing, parser/read units                                                            | React/Tauri seams, mtime-only saves, incomplete root/symlink/special-file authority, majority-EOL normalization, non-streamed search, raw remote URLs, self-arming OSC                                |
| bb                 | [`52a9256373d4d36f9b60e9e2a7f333464091a2ac`](https://github.com/get-bb/bb/tree/52a9256373d4d36f9b60e9e2a7f333464091a2ac)           | MIT; Pierre and other dependencies separate                                                                                      | Adapt small TypeScript units                                 | Split operations, bounded terminal queues/reconnect, PDA handling, `.worktreeinclude`, expected-SHA merge, ACP model normalization | N-ary/global persistence, Node/string/in-memory PTY, unauthenticated transport, process-local locks, non-durable merge cleanup, React/Pierre runtime                                                  |
| Zeron              | [`30a9a9537c5ec96226c87f4bf349b6f77c5dfb59`](https://github.com/zeronsh/zeron/tree/30a9a9537c5ec96226c87f4bf349b6f77c5dfb59)       | MIT; third-party notices apply                                                                                                   | Translate proven Rust models/UI semantics                    | Appearance/theme separation, native/ACP registry, models/commands, preferences, archive/history                                    | No M10 runtime-node authority, incomplete install/version/health contract, no reduced-transparency policy, unverified “User supplied” theme license                                                   |
| Muxy               | [`5c5be8697c57a2fe70cda97fdbaf7c912e2e31b6`](https://github.com/muxy-app/muxy/tree/5c5be8697c57a2fe70cda97fdbaf7c912e2e31b6)       | MIT                                                                                                                              | Translate split/worktree units with hardening                | Split semantics, staged worktree UX, identity-race tests, process measurement                                                      | Cwd/name-based ownership, `lsof` free-port killing, `shell -c` hooks, PID/PGID reuse, partial persistence, ID/path mismatch restore                                                                   |
| Buzz               | [`eed74bde2f4797714335ac10c56c0b0244c1def4`](https://github.com/block/buzz/tree/eed74bde2f4797714335ac10c56c0b0244c1def4)          | Apache-2.0; no repository-level NOTICE                                                                                           | Adapt selected runtime and PTY units with Adea NOTICE        | Runtime/model inheritance resolution, ordered teams, renderer publication flow, PTY environment allowlist                          | Nostr/community/team identity, credential inheritance semantics, Tauri/React transport, renderer credit as authentication or replay                                                                   |
| `hexuria/opengrok` | [`2bf49b3ca5a72c09b169a282a8cea16373a85288`](https://github.com/hexuria/opengrok/tree/2bf49b3ca5a72c09b169a282a8cea16373a85288)    | No source license grant; unofficial binary-derived Grok Bot reconstruction                                                       | **Prohibited**                                               | Nothing. Only abstract observations independently present in the owner's note                                                      | Entire Git history/tree/cache, source, tests, comments, identifiers, strings, CSS, protobufs, manifests, screenshots, fonts/icons, audio, binaries, extracted evidence, vendor files, and adaptations |

## Source findings by donor

### KiroCrew

Relevant evidence:

- shell/navigation: `website/src/pages/ChatSidebar.tsx`,
  `website/src/pages/chat/SidePanel.tsx`;
- App Library: `website/src/pages/apps/DiscoverPage.tsx:580-588` composes
  `website/src/components/appstore/CategoryRail.tsx:1-72`; tests include
  `website/playwright/apps.spec.ts` and
  `website/src/test/appstoreCategories.test.ts`;
- project scanner: `src/kiro_crew/project_scan.py:1-31,1465-1662`; nearest
  tests are `test/test_project_scan_{members,properties,models,fixtures,walker}.py`;
- ACP: `src/kiro_crew/acp/client.py:3384`, `runtime.py:698`, and
  `session_provider.py:49`; nearest client/runtime/provider tests apply, while
  `test/test_acp_frame_replay.py` pins parser/routing snapshots only;
- browser: `docs/system-specs/modules/browser.md:435-468` and launcher,
  CLI-view, Electron BrowserView, and web hook tests.

The scanner must be decomposed into bounded TypeScript modules; do not translate
the 1,662-line Python file wholesale. KiroCrew already displays linked PR/issue
and lifecycle/CI state; Adea's gap is repo/worktree-level tracking, not all PR
tracking. Any substantial Apache reuse carries its NOTICE obligations.

### Orca

Strong evidence:

- project/repo/group model: `src/shared/project-types.ts`,
  `repo-types.ts`, `project-groups.ts`;
- worktrees: `src/main/runtime/orca-runtime-create-managed-worktree.ts`,
  `src/main/worktree-removal-safety.ts:65-192`,
  `src/main/worktree-trash.ts:34-130`,
  `src/main/runtime/repo-worktree-admin-fingerprint.ts:15-23`;
- terminal history and readiness: `src/main/terminal-history.ts`,
  `src/main/shell-startup-features.ts`, `src/main/daemon/**`;
- write gate: `src/main/runtime/agent-session-pty-write-gate.ts:20-145`;
- event parser: `src/shared/agent-status-osc.ts:23-130`;
- GitHub: `src/main/github/client/**` plus repository-level
  `src/main/github/client-*.test.ts` and IPC/routing tests;
- browser/device: `src/main/browser/**`, `src/main/emulator/**`.

Required redesigns:

- `runtime-worktree-status-projection.ts` uses title/PTY heuristics; Adea uses a
  provenance/freshness reducer;
- persisted `fishHistoryDir` is not sufficient deletion authority;
- `(pid, port)` is not enough to terminate after a PID-reuse race;
- a 200-item trash sweep cap needs durable continuation;
- memory collection is process-wide singleton state and usage is local
  Claude/Codex-focused; neither provides runtime-node port ownership.

### t3code

Evidence includes `apps/server/src/terminal/{PtyAdapter,BunPtyAdapter}.ts`,
preview/browser modules, `apps/server/src/preview/PortScanner.ts`,
`apps/server/src/vcs/GitVcsDriver.ts:714-791`, and
`packages/contracts/src/editor.ts`.

Do not inherit:

- `TextDecoder` string output instead of byte-preserving chunks;
- arbitrary absolute reads or relative writes without immediate realpath-parent
  containment recheck;
- shell command text in `ProjectSetupScriptRunner`;
- `git worktree remove --force` as cleanup authority;
- cookie import that continues after individual failures;
- default preview permissions for clipboard, notifications, and geolocation;
- a configurable usage URL that receives a bearer management key without strict
  host/scheme/private-network/redirect policy.

### Warp

The observed behaviors are real, including pane operations, command-palette
composition, DCS hooks, blocks, pinned content, bottom input, and block filters.
The relevant implementation is AGPL. Adea's implementer must derive models and
tests from [ADR 0009](../decisions/0009-dev-view-control-plane.md) and the
[Dev Runtime spec](../specs/dev-runtime.md), not Warp's symbols, source
structure, tests, or fixtures. OSC 133 and OSC 7 are public protocol-level
requirements only; Adea's authenticated wrapper is independently named and
designed.

Release evidence must include a changed-production-file semantic denylist scan,
exact symbol/schema/literal scan, manual structural-similarity review, and an
implementer attestation. The scan allowlists only the provenance/policy evidence
files named below for literal donor names, URLs, and OIDs; those literals are
forbidden in production source, tests derived from Warp, and packaged output.
Record “reviewed, no code reused”; do not add Warp to Adea `NOTICE` unless
separately reviewed licensed material is actually used.

### terax-ai

Useful UI evidence:

- `src/modules/editor/{EditorPane,GitDiffPane,AiDiffPane}.tsx`;
- `src/modules/explorer/FileExplorer.tsx:62-75`;
- `src/modules/source-control/SourceControlPanel.tsx:90-106`;
- `src/app/App.tsx:1443-1468`.

Authority gaps:

- several registered filesystem commands bypass `WorkspaceRegistry`;
- reads follow symlinks and may read special files;
- recursive copy accepts absolute external sources;
- save conflict is an mtime preflight followed by an unconditional write;
- mixed EOL is reduced to majority LF/CRLF;
- filename search is capped synchronous collection and content search is an
  in-process `grep-searcher` walker, not streamed `rg`;
- raw configured remote URLs can reach the UI unredacted; a separate web-link
  helper truncates nested GitLab namespace paths;
- `agent_detect.rs:163-215` self-arms known agents from unauthenticated OSC 777
  and OSC 133 bytes.

### bb

Potentially adaptable concepts live in:

- `apps/app/src/lib/split-layout/**`;
- `apps/host-daemon/src/terminals/terminal-manager.ts`;
- `packages/client-core/src/terminal/terminal-websocket-transport.ts`;
- `packages/host-workspace/src/{worktree-include,worktree-metadata-lock,workspace}.ts`;
- `packages/provider-bridge-acp/src/bridge/model-catalog.ts`.

The split model is n-ary and globally persisted through Zod; Adea is strict
binary with scoped hand validation. The PTY is Node/node-pty, string-based,
in-memory, and terminal-ID scoped. The transport's queue/reconnect/heartbeat
are availability mechanics, not authentication or checkpoint resync. Locks are
process-local. Include copying needs type/count/byte and TOCTOU defenses. Merge
cleanup must retain durable recovery state. Pierre's React peer dependencies
and bb's React worker contexts do not enter Adea.

### Zeron

Useful semantics exist in `crates/ui/src/appearance.rs`, `crates/theme/src/**`,
`crates/harness/**`, `crates/engine/src/{registry,rpc}.rs`,
`crates/ui/src/settings/{composer,archived}.rs`, and `crates/ui/src/history.rs`.
Zeron supports system/light/dark, independent theme variants, native and ACP
harnesses, model/command RPCs, persistent composer preferences, archive, and
paged history. It does not provide Adea's M10 authorization/runtime-node model,
translucent/reduced-transparency policy, or canonical cross-view session.
Local theme imports set license to “User supplied” and require non-empty
provenance, but do not verify license accuracy or redistribution permission.

### Muxy

Useful evidence:

- split tree and tests: `Muxy/Models/Workspace/SplitNode.swift`,
  `Tests/MuxyTests/Models/Workspace/SplitNodeTests.swift`;
- worktree flows: `Muxy/Services/Project/WorktreeStore.swift`, setup/teardown
  runners, Git removal, and corresponding tests;
- race examples: `Muxy/Services/Git/WorktreeProcessQuiescer.swift` and tests.

Do not inherit cwd-based process ownership, `lsof`-wide “Free Port” signalling,
`shell -c` hooks, pre-validation teardown, unfenced delayed PID/PGID signals,
partially committed removal state, ID-over-conflicting-path restore, or
executable-name identity. Measurements may enrich a read model but never grant
kill authority.

### Buzz

Useful concepts:

- runtime/model inheritance and reset:
  `desktop/src/features/agents/lib/resolvePersonaRuntime.ts` and adjacent model
  helpers;
- team/channel behavior and community-scoped participant-set DMs;
- bounded renderer publication:
  `desktop/src-tauri/src/terminal_transport.rs:64-178,257-380`;
- environment allowlisting:
  `desktop/src-tauri/crates/buzz-terminal/src/env_fence.rs` and tests.

Linked Buzz instances may inherit provider/model from persona and global
configuration, so Buzz does not prove Adea credential independence. Renderer
credit does not prove authentication, byte replay, PTY ownership, generation
binding, or network policy. Ignored/pending multitenant tests are contract
evidence, not passing isolation coverage.

### `hexuria/opengrok`

`NOTICE.md` and `PROVENANCE.md` identify a reconstruction from distributed
Grok Bot binaries and grant no upstream source license. The tree contains
mechanically recovered/transcribed source and extracted assets. Public
availability, repository ownership, and dependency licenses do not grant reuse
rights. Only independent observations already in the owner's note may inform
Adea.

The release scan covers added Git blobs and packaged artifacts, not only the
final working tree. `AGENTS.md`, `docs/research/dev-view-donor-audit.md`,
`docs/research/dev-view-source-manifest.json`, ADR 0009, the Dev Runtime spec,
threat model, implementation guide, M12 plan, and required license/NOTICE rows
are the only literal-name/URL/OID allowlist because they are review evidence.
Production code, production/test identifiers, copied fixtures, assets, and
packaged output deny Warp/OpenGrok names, URLs, OIDs, documented binary/asset
hashes, recovered material, and structural/source-derived signatures. The scan
configuration itself may contain hashes/signatures solely as non-shipping
detection data. A semantic/manual review remains required because renaming can
bypass literal scans.

## File-level provenance ledger

### Shared UI reconciliation inventory

[The traceability inventory](dev-view-ui-traceability.json) extends this ledger
and the pinned source manifest for the donor-first shared UI migration. It is an
in-progress inventory, not a replacement architecture or a completion certificate.
It records inspection bases, issue/PR coverage and retrieval limits, accepted
conflicts, mapped source/test paths, current destination existence, ownership,
and separate readiness dimensions. A pinned checkout or a closed issue does not
mark source review, consumer adoption, or packaged acceptance complete.

Reference recovery now contains 414 issue/PR records: Adea M12/M13 and Cortana's
relevant milestone seeds, plus recognized recursive body/conversation references
and paginated comments. The initial 271 records expanded by 143, with no unresolved
recognized in-repository reference in this snapshot. Retrieval does not establish
semantic approval or implementation scope: shorthand/ranges, external compatibility
sources, PR review threads/diffs, acceptance evidence and current production chains
still need review. Historical manual waivers are retained as waivers.

| Workflow                     | Preserve or investigate                                                       | Remaining evidence                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Shell/layout                 | Existing mapped KiroCrew hierarchy and bb/Muxy binary operations              | Compare pinned units/tests; extract generic presentation; actual responsive/keyboard consumer paths  |
| Projects/worktrees           | Existing registry, launch and safe cleanup authority                          | Shared hierarchy/actions with real launch, blockers, retry and result                                |
| Appearance/App Library       | #425's amended live composition and existing verified catalogue               | Shared presentation, preference/capability ports, visual and recovery journeys                       |
| Chat/history                 | One canonical RuntimeSession; distinct team-channel domain                    | Returning-user entry, mounted search, real notification publication and full journey                 |
| Files/editor/diff            | Existing Terax adaptation and fixes; persistent tree                          | #677 keyboard behavior and current performance/worker/cancellation evidence                          |
| Browser/devices              | Existing pinned models and native engine contracts                            | #718/#735 mounted handlers, service effects, usable screenshot/annotation results                    |
| Resources/permissions        | Existing probes, scoped authority and safe summaries                          | Source-level provenance review; actual status/action/recovery evidence                               |
| Cortana knowledge/operations | Accepted knowledge workflow, evidence distinctions and operational boundaries | Reusable extraction, current shared-control adoption, packed consumers and independent graph loading |
| Package contracts            | Separate UI/theme authority; optional heavy features                          | Packed condition/export checks, notice delivery, lazy assets and production entry graphs             |

The themes package's native ESM and isolated-palette findings are addressed in
[themes PR #6](https://github.com/adea-ai/themes/pull/6), with local packed
consumer checks. Application adoption and release evidence remain pending. UI
packing also exposed missing folder entry points, omitted license/NOTICE, leaked
test declarations, and root imports requiring absent optional chart/carousel
peers. These findings are tracked separately from donor adoption.

### Standalone appearance extraction checkpoint

[UI PR #17](https://github.com/adea-ai/ui/pull/17) extracts the existing accepted
Zeron appearance composition into controlled Solid presentation. Its full MIT
headers and standalone UI NOTICE preserve revision
`30a9a9537c5ec96226c87f4bf349b6f77c5dfb59`,
`crates/ui/src/settings/appearance.rs`, and `crates/ui/src/settings/widgets.rs`.
These units were already identified in the accepted provenance ledger; the
source manifest now makes their presentation/test handoff explicit separately
from the still-pending theme model and App Library units.

Thirteen component checks passed, including native Node server rendering,
headless browser keyboard/menu/snapshot/custom-accent/pending-save behavior and
responsive axe checks. Five composed stories build. This is component evidence:
Adea/Cortana migration, preference/native adapters, packed component consumption,
complete workshop browser CI, manual AT and packaged acceptance remain pending.
[UI PR #16](https://github.com/adea-ai/ui/pull/16) remains the export/NOTICE
prerequisite and retains its unresolved root optional-peer compatibility gate.
The combined #425 workflow remains in progress; no old appearance system is
removed by the extraction.

### Adapted files

Every implementation PR that uses donor material must add a row here and the
matching Adea `NOTICE` entry in the same commit.

| Destination                                                                                                                                                                                               | Donor source                                                                                                                                                                                                                                          | Pinned revision                                                                                  | License/NOTICE                                                                    | Retained behavior                                                                                                                                                                                                                                                                                                                                                                                   | Adaptation boundary                                                                                                                                                                                                                                                                                                            | Evidence                                                                                                                                                       | NOTICE section         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `packages/dev-view/src/dev-workspace-entry.tsx`; `packages/dev-view/src/sidebar/dev-sidebar-shell.tsx`; `packages/dev-view/src/sidebar/archive-shelf.tsx`                                                 | KiroCrew `website/src/pages/ChatSidebar.tsx`; `website/src/pages/chat/SidePanel.tsx`; `website/src/hooks/panelTabRegistry.ts`                                                                                                                         | `283e136c0f902e965a535a7c9548c57c7504fed0`                                                       | Copyright Amazon.com, Inc. or its affiliates; Apache-2.0 and donor `NOTICE`       | Substantial Solid translation of shell decomposition and hierarchy interactions                                                                                                                                                                                                                                                                                                                     | Replaced React/Electron seams, dependencies, styling, data ownership, and actions with Solid, semantic controls, typed unavailable runtime service, and Adea-responsive composition                                                                                                                                            | Dev route/build/type checks and packaged UI validation in issue #395                                                                                           | KiroCrew section       |
| `packages/dev-view/src/layout/operations.ts`                                                                                                                                                              | bb `apps/app/src/lib/split-layout/ops.ts`; Muxy `Muxy/Models/Workspace/SplitNode.swift`                                                                                                                                                               | bb `52a9256373d4d36f9b60e9e2a7f333464091a2ac`; Muxy `5c5be8697c57a2fe70cda97fdbaf7c912e2e31b6`   | Copyright (c) 2026 Michael Yong, MIT; Copyright (c) 2026 Muxy, MIT                | Substantial TypeScript/Swift-to-TypeScript translation of strict binary traversal, split, removal, promotion, ordering, and ratio semantics                                                                                                                                                                                                                                                         | Immutable Adea node model; deterministic IDs supplied by caller; 8-leaf/depth limits; focus, move, finite-ratio clamp, last-pane placeholder, and undo                                                                                                                                                                         | `packages/dev-view/tests/layout.test.ts` in issue #395                                                                                                         | bb and Muxy sections   |
| `packages/dev-view/src/layout/persistence.ts`                                                                                                                                                             | bb `apps/app/src/lib/split-layout/persistence.ts`                                                                                                                                                                                                     | `52a9256373d4d36f9b60e9e2a7f333464091a2ac`                                                       | Copyright (c) 2026 Michael Yong; MIT                                              | Substantial persistence-state translation                                                                                                                                                                                                                                                                                                                                                           | Replaced global/Zod persistence with exact authority-scoped versioned records, strict binary validation, private-field exclusion, and unread corrupt/future retention                                                                                                                                                          | `packages/dev-view/tests/persistence.test.ts` in issue #395                                                                                                    | bb section             |
| `packages/ui/src/components/appearance.ts`                                                                                                                                                                | Zeron `crates/theme/src/lib.rs`                                                                                                                                                                                                                       | `30a9a9537c5ec96226c87f4bf349b6f77c5dfb59`                                                       | Copyright (c) 2026 Wing; MIT                                                      | Substantial TypeScript translation of the color math, accent role derivation, independent light/dark selection, surface resolution, registry fallback, and validation rules                                                                                                                                                                                                                         | Replaced Rust/serde models with TypeScript records; added custom accent validation, the translucent capability gate, the user reduced-transparency policy Zeron lacks, CSS token projection, and the pre-paint no-flash script                                                                                                 | `packages/ui/tests/appearance.test.ts` in issue #425                                                                                                           | Zeron section          |
| `packages/workspace-ui/src/plugins-dialog.tsx` (App Library composition)                                                                                                                                  | KiroCrew `website/src/pages/apps/DiscoverPage.tsx`; `website/src/components/appstore/CategoryRail.tsx`                                                                                                                                                | `283e136c0f902e965a535a7c9548c57c7504fed0`                                                       | Copyright Amazon.com, Inc. or its affiliates; Apache-2.0 and donor `NOTICE`       | Composition translation of category counts, search, discover/installed states, and detail affordances                                                                                                                                                                                                                                                                                               | Replaced React and Kiro registry seams with Solid over Adea's verified catalog and install plans; added the Navigation tab, bundled-first-party activation gating, and app surface metadata                                                                                                                                    | `packages/workspace-ui/tests/unit/app-library.test.ts`; `apps/web/e2e/appearance.spec.ts` in issue #425                                                        | KiroCrew section       |
| `apps/desktop/shell/src/dev-runtime/discovery/probe.ts`                                                                                                                                                   | Zeron `crates/harness/src/lib.rs`; `crates/harness/src/claude/mod.rs`; `crates/harness/src/acp/mod.rs`                                                                                                                                                | `30a9a9537c5ec96226c87f4bf349b6f77c5dfb59`                                                       | Copyright (c) 2026 Wing; MIT                                                      | Substantial Rust-to-TypeScript translation of the executable resolution order (override → PATH → known HOME-relative and absolute locations → node-version-manager bins) and existence-only install probing                                                                                                                                                                                         | Added injectable fs/env probes for deterministic tests, a fixed-argv bounded version probe (10 s, 1 MiB) that never emits output into diagnostics, dangling-symlink refusal, and EACCES-aware classification; the login-shell PATH snapshot stays an explicit integration hook                                                 | `apps/desktop/tests/dev-runtime-discovery.test.ts` in M10 issue #30                                                                                            | Zeron section          |
| `apps/desktop/shell/src/dev-runtime/discovery/families.ts`                                                                                                                                                | Orca `src/shared/tui-agent.ts`                                                                                                                                                                                                                        | `403b62a8d8fa6e896a93acc4c15405be0f0b7dc7`                                                       | Copyright (c) 2026 Lovecast Inc.; MIT                                             | Translation of the closed supported-agent registry shape into a per-family detection/probe/eligibility spec table                                                                                                                                                                                                                                                                                   | Replaced the flat string union with typed family specs carrying executables, protocol, version argv, existence-only auth markers, declared/required capabilities, session operations, and limitations; managed Pi and ACP families stay with M10 #31/#32                                                                       | `apps/desktop/tests/dev-runtime-discovery.test.ts` in M10 issue #30                                                                                            | Orca section           |
| `packages/dev-view/src/browser/mini-preview-layout.ts`; `packages/dev-view/tests/browser-models.test.ts` (geometry cases)                                                                                 | t3code `apps/web/src/components/preview/previewMiniPlayerLayout.ts`; `apps/web/src/components/preview/previewMiniPlayerLayout.test.ts`                                                                                                                | `77bca8b2d76a1f42552e5eee7d277fcb1160347a`                                                       | Copyright (c) 2026 T3 Tools Inc.; MIT                                             | Verbatim transcription of the pure floating-player geometry (fit, clamp, obstacle sliding, resize lead-axis) and its test cases                                                                                                                                                                                                                                                                     | Replaced donor viewport/device type seams with Adea Dev Runtime types and removed the fitted-viewport helper dependency; Adea z-index layering note                                                                                                                                                                            | `packages/dev-view/tests/browser-models.test.ts` in issue #422                                                                                                 | t3code section         |
| `packages/dev-view/src/browser/ports-model.ts`                                                                                                                                                            | t3code `apps/web/src/components/preview/useDiscoveredLocalServers.ts` and its test                                                                                                                                                                    | `77bca8b2d76a1f42552e5eee7d277fcb1160347a`                                                       | Copyright (c) 2026 T3 Tools Inc.; MIT                                             | Substantial translation of `mergeServers`, `canonicalKey`, and configured-URL parsing plus its test cases                                                                                                                                                                                                                                                                                           | Replaced the React hook with a pure merge; added Adea ownership/health gating so only proven Adea-owned listening loopback services are previewable                                                                                                                                                                            | `packages/dev-view/tests/browser-models.test.ts` in issue #422                                                                                                 | t3code section         |
| `packages/dev-view/src/browser/annotation-model.ts`                                                                                                                                                       | t3code `apps/desktop/src/preview/AnnotationKeyboard.ts`; `apps/desktop/src/preview/PickedElementPayload.ts` and their tests                                                                                                                           | `77bca8b2d76a1f42552e5eee7d277fcb1160347a`                                                       | Copyright (c) 2026 T3 Tools Inc.; MIT                                             | Verbatim transcription of the submission resolver and payload validators plus their test cases                                                                                                                                                                                                                                                                                                      | Added the tool-shortcut resolver (v/r/d/e, Escape cancel) from the donor PickPreload overlay interaction model                                                                                                                                                                                                                 | `packages/dev-view/tests/browser-models.test.ts` in issue #422                                                                                                 | t3code section         |
| `apps/desktop/shell/src/dev-runtime/browser/port-inventory.ts`                                                                                                                                            | t3code `apps/server/src/preview/PortScanner.ts` (lsof field parsing, local-host tokens, bounded HTML probe structure)                                                                                                                                 | `77bca8b2d76a1f42552e5eee7d277fcb1160347a`                                                       | Copyright (c) 2026 T3 Tools Inc.; MIT                                             | Translation of `parseLsofOutput`, `parsePortFromLsofName`, `LSOF_LOCAL_HOST_TOKENS`, and the scan/probe skeleton                                                                                                                                                                                                                                                                                    | Dropped the common-port fallback, LAN-visible hosts, and Effect host; added Adea-owned launch-metadata ownership, stale-port retention, and previewability proof                                                                                                                                                               | `apps/desktop/tests/dev-runtime-browser.test.ts` in issue #422                                                                                                 | t3code section         |
| `apps/desktop/shell/src/dev-runtime/browser/lane-registry.ts` (profile identity derivation)                                                                                                               | orca `src/main/browser/browser-route-identity.ts`                                                                                                                                                                                                     | `403b62a8d8fa6e896a93acc4c15405be0f0b7dc7`                                                       | Copyright (c) 2026 Lovecast Inc.; MIT                                             | Translation of the domain-separated, versioned identity digest structure                                                                                                                                                                                                                                                                                                                            | Digest components replaced with Adea `(account, workspace, node, session, kind)` so lane kinds and scopes can never collide; generation fencing and deny-by-default policies are Adea additions                                                                                                                                | `apps/desktop/tests/dev-runtime-browser.test.ts` in issue #422                                                                                                 | orca section           |
| `apps/desktop/shell/src/dev-runtime/browser/screencast.ts`                                                                                                                                                | orca `src/main/browser/browser-screencast-frame-pacer.ts`; Buzz `desktop/src-tauri/src/terminal_transport.rs` (bounded newest-frame publication only)                                                                                                 | orca `403b62a8d8fa6e896a93acc4c15405be0f0b7dc7`; Buzz `eed74bde2f4797714335ac10c56c0b0244c1def4` | Copyright (c) 2026 Lovecast Inc.; MIT; Copyright (c) 2026 Block, Inc.; Apache-2.0 | Translation of the newest-throttled-frame pacer, backpressure retry, and one-in-flight credit idea                                                                                                                                                                                                                                                                                                  | Replaced Electron debugger and CDP acks with a credit-gated publisher seam; added lane generation/viewport-sequence input fencing and the spec's 240 inputs/s, 15/30 FPS, 8 MiB limits                                                                                                                                         | `apps/desktop/tests/dev-runtime-browser.test.ts` in issue #422                                                                                                 | orca and Buzz sections |
| `apps/desktop/shell/src/dev-runtime/browser/cookie-import.ts` (policy and scope)                                                                                                                          | orca `src/main/browser/browser-cookie-import-policy.ts`; `browser-cookie-import-clear-atomicity.test.ts`; `browser-cookie-import-scope.test.ts`                                                                                                       | `403b62a8d8fa6e896a93acc4c15405be0f0b7dc7`                                                       | Copyright (c) 2026 Lovecast Inc.; MIT                                             | Translation of domain normalization, registrable-family scoping, the google.com non-transplantable exclusion, and the frozen-plan rollback semantics with the donors' test cases                                                                                                                                                                                                                    | Replaced the `psl` dependency with an explicit multi-label suffix table; replaced partial-success continuation with a digest-bound plan/commit transaction that rolls the whole import back on failure or cancel; values never enter digests, results, or logs                                                                 | `apps/desktop/tests/dev-runtime-browser.test.ts` in issue #422                                                                                                 | orca section           |
| `apps/desktop/shell/src/dev-runtime/devices/inventory.ts`; `apps/desktop/shell/src/dev-runtime/devices/device-sessions.ts`; `apps/desktop/tests/dev-runtime-devices.test.ts`                              | orca `src/main/emulator/simctl-simulator-devices.ts`; `src/main/emulator/android/android-device-inventory.ts` + `adb-devices` parsing; `android-input-mapping` argv tables; `emulator-session-registry.ts` managed-session rules; the backends' tests | `403b62a8d8fa6e896a93acc4c15405be0f0b7dc7`                                                       | Copyright (c) 2026 Lovecast Inc.; MIT                                             | Translation of the simctl/adb/AVD parsers, merged-inventory shape, pixel clamping and keycode tables, fixed argv templates, and the managed/unmanaged stop rules with the donors' test cases                                                                                                                                                                                                        | Replaced serve-sim/Electron/scrcpy helper seams with capability-gated typed unavailability; start binds to verified inventory IDs + generations and stop rechecks the Adea launch identity before any signal                                                                                                                   | `apps/desktop/tests/dev-runtime-devices.test.ts` in issue #422                                                                                                 | orca section           |
| `packages/dev-view/src/appearance/editor.ts`; `packages/dev-view/src/appearance/appearance-dialog.tsx`; `packages/dev-view/src/appearance/composition.ts`; `packages/ui/src/components/theme-preview.tsx` | Zeron `crates/ui/src/appearance.rs`; `crates/ui/src/settings/appearance.rs`; `crates/ui/src/settings/widgets.rs`                                                                                                                                      | `30a9a9537c5ec96226c87f4bf349b6f77c5dfb59`                                                       | Copyright (c) 2026 Wing; MIT                                                      | Substantial translation of the appearance state, unchanged-value setter semantics, live palette re-resolution, and the visual composition: mode mini-preview cards with the split light/dark miniature, card rows with compact palette-preview theme dropdowns, the accent swatch row over helper copy, the segmented glass control, and the theme-library row behind the declared-license contract | Replaced GPUI globals with a Solid provider plus a snapshot draft editor; added the explicit save/revert/Reset contract, the validated custom accent picker, and reduced-transparency status; the donor ThemeDefault glass pole is carried by Adea's translucent slot, and theme import is contract-gated rather than executed | `packages/dev-view/tests/appearance-editor.test.ts`; `packages/dev-view/tests/appearance-composition.test.ts`; `apps/web/e2e/appearance.spec.ts` in issue #425 | Zeron section          |

| `apps/desktop/shell/src/dev-runtime/worktrees/service.ts` | Orca `src/main/runtime/orca-runtime-create-managed-worktree.ts`; Muxy `Muxy/Services/Project/WorktreeStore.swift` (staged create→store→refresh semantics only) | Orca `403b62a8d8fa6e896a93acc4c15405be0f0b7dc7`; Muxy `5c5be8697c57a2fe70cda97fdbaf7c912e2e31b6` | Copyright (c) 2026 Lovecast Inc., MIT; Copyright (c) 2026 Muxy, MIT | Substantial translation of the create coordinator and staged lifecycle sequencing | Replaced Electron IPC/agent-trust/startup seams with the M10 bookmark authority, cross-process per-repo mutation lock, idempotency ledger, durable pre-side-effect records, leases, retired names, include-copy and approved-argv bootstrap stages; folder repos register without a filesystem create | `apps/desktop/tests/worktree-service.test.ts`; `worktree-bootstrap-leases-templates.test.ts` in issue #397 | Orca and Muxy sections |
| `apps/desktop/shell/src/dev-runtime/worktrees/trash.ts` | Orca `src/main/worktree-trash.ts` | `403b62a8d8fa6e896a93acc4c15405be0f0b7dc7` | Copyright (c) 2026 Lovecast Inc.; MIT | Substantial translation of rename-to-trash, restore, and startup sweep | Fail-closed replaces in-place delete fallback; entry provenance records + identity reproof before delete; persisted sweep backlog/cursor with requeue of not-yet-proven entries; owner-only trash root | `apps/desktop/tests/worktree-trash-sweep.test.ts` in issue #397 | Orca section |
| `apps/desktop/shell/src/dev-runtime/worktrees/identity.ts` (fingerprint + dangerous-path sections); `worktrees/concurrency.ts` | Orca `src/main/runtime/repo-worktree-admin-fingerprint.ts`; `src/main/worktree-removal-safety.ts`; `src/shared/map-with-concurrency.ts` | `403b62a8d8fa6e896a93acc4c15405be0f0b7dc7` | Copyright (c) 2026 Lovecast Inc.; MIT | Substantial translation of the subprocess-free admin fingerprint, deletion-safety predicates, and bounded parallelism | Added gitdir backlink proof (`commondir` + admin `gitdir` reproof), strict file-identity comparison for content freshness, POSIX dangerous-path set, and canonical path handling for macOS `/var` spelling | `apps/desktop/tests/worktree-identity.test.ts` in issue #397 | Orca section |
| `apps/desktop/shell/src/dev-runtime/worktrees/retired-names.ts`; `worktrees/name-pool.ts` | Orca `src/shared/worktree/retired-name-registry.ts`; `src/shared/worktree-name-suggestion.ts`; `src/shared/marine-creature-names-*.ts` | `403b62a8d8fa6e896a93acc4c15405be0f0b7dc7` | Copyright (c) 2026 Lovecast Inc.; MIT | Substantial translation of tier parsing, watermark compaction, registry merge, and collision-safe suggestion | Service-integrated persistence (per-common-dir registry store), creation-path collision refusal, and deterministic test fixtures preserved from the donor suite | `apps/desktop/tests/worktree-retired-names.test.ts` in issue #397 | Orca section |
| `apps/desktop/shell/src/dev-runtime/worktrees/include-copy.ts` | bb `packages/host-workspace/src/worktree-include.ts` | `52a9256373d4d36f9b60e9e2a7f333464091a2ac` | Copyright (c) 2026 Michael Yong; MIT | Substantial translation of the git-derived include plan and copy loop | Plan/commit digests; hard count/byte budgets; fail-closed symlink/special-file/escape refusals (bb skipped silently); secret-like item approvals; per-copy identity/containment reproofs; CoW `COPYFILE_FICLONE\|COPYFILE_EXCL` clones | `apps/desktop/tests/worktree-include-copy.test.ts` in issue #397 | bb section |
| `apps/desktop/shell/src/dev-runtime/worktrees/merge.ts` | bb `packages/host-workspace/src/workspace.ts` (`squashMergeInto`) | `52a9256373d4d36f9b60e9e2a7f333464091a2ac` | Copyright (c) 2026 Michael Yong; MIT | Substantial translation of temporary-detached-worktree squash merge and expected-SHA publication | Typed plan/digest with moved-ref refusal; durable recovery records + retained temp worktree on conflict/crash (replaced the donor's `finally` removal); CAS branch deletion helper; registered-temp cleanup with prune verification | `apps/desktop/tests/worktree-merge.test.ts` in issue #397 | bb section |

| `packages/dev-view/src/permissions/model.ts`; `packages/dev-view/src/permissions/permissions-pane.tsx` | Orca `src/renderer/src/components/settings/DeveloperPermissionsPane.tsx`; `DeveloperPermissionActions.tsx`; `developer-permission-status.ts`; `DeveloperPermissionsPane.test.tsx` | `403b62a8d8fa6e896a93acc4c15405be0f0b7dc7` | Copyright (c) 2026 Lovecast Inc.; MIT | Translation of the status pane structure, status chip copy/tone taxonomy, Request vs Open Settings affordance selection, and the focus-return re-check (no polling, no nag loop) with the donor pane tests' state matrix | Replaced Electron `systemPreferences` with the injected `MacPermissionsPageService` port and a typed-unavailable service so no lane renders a fixture state; rows carry Adea feature reasons and consequences; denial never offers Request (macOS ignores re-prompts); polite live-region announcements fire only on state change; no transitions (reduced motion is structural) | `packages/dev-view/tests/permissions-model.test.ts` in issue #471 | Orca section |
| `apps/desktop/shell/src/desktop-permissions.ts` | Orca `native/computer-use-macos/Sources/OrcaComputerUseMacOSCore/PermissionStatusSnapshot.swift`; `PermissionTrustSettling.swift` and their tests | `403b62a8d8fa6e896a93acc4c15405be0f0b7dc7` | Copyright (c) 2026 Lovecast Inc.; MIT | Translation of the snapshot-with-injectable-probes structure, the single-flight refresh coordinator, and the bounded trust-settling poll with the donors' scripted-outcome test cases | Replaced Swift AX/CG native probes with fixed-argv `osascript` commands whose refusal text classifies denied and whose probe deadline maps a pending consent prompt to `not_determined`; unprobeable permissions report typed `capability_unavailable`; deep links live only in the shell's frozen `SETTINGS_PANES` table opened through fixed-argv `open`, so no client URL is ever honored | `apps/desktop/tests/shell-permissions.test.ts` in issue #471 | Orca section |
| `apps/desktop/shell/src/dev-runtime/computeruse/capability.ts`; `consent-gate.ts`; `providers.ts` (bounded frame/cache admission) | Orca `native/computer-use-macos/Sources/OrcaComputerUseMacOSCore/PermissionStatusSnapshot.swift`; `PermissionTrustSettling.swift`; `ComputerSnapshotCachePolicy.swift` and their tests | `403b62a8d8fa6e896a93acc4c15405be0f0b7dc7` | Copyright (c) 2026 Lovecast Inc.; MIT | Translation of the permission-preflight structure (no action begins unless a probe proves its TCC service), the trust-settling deadline semantics, and the snapshot cache policy (a cached permission answer is never presented as fresh; bounded newest-snapshot retention) with the donors' scripted-outcome test matrices | Replaced the Swift native probes with consumption of the #471 fixed-argv permission service; consent records are issuance-backed, scope/lane/generation-bound, single-use, ≤60 s, and re-verified inside a bounded freshness window; ScreenCapturePermissionPreflightSafety's refuse-closed rule becomes typed `capability_unavailable` for capture while the native helper is deferred | `apps/desktop/tests/dev-runtime-computeruse.test.ts` in issue #472 | Orca section |
| `packages/dev-view/src/computeruse/computeruse-model.ts`; `computeruse-pane.tsx` | Orca `src/renderer/src/components/settings/DeveloperPermissionsPane.tsx` row scaffolding; `src/main/computer/desktop-script-runtime-host.ts`; `desktop-script-snapshot-rendering.ts` | `403b62a8d8fa6e896a93acc4c15405be0f0b7dc7` | Copyright (c) 2026 Lovecast Inc.; MIT | Translation of the status-row/affordance scaffolding and the runtime-host + bounded-snapshot-rendering shape | Electron/remote-desktop transport replaced by Adea's `desktop-frames-v1` stream, the M10 gate, and the #472 consent gate; the pane renders only injected capability truth (no fixture states), offers consent/takeover/release/kill-switch affordances per lane state, and announces only real state changes | `packages/dev-view/tests/computeruse-model.test.ts` in issue #472 | Orca section |
| `apps/desktop/shell/src/dev-runtime/resources/**` (metrics history, policy authority, registrar); `apps/desktop/shell/src/dev-runtime/usage/**` (contract, fetch policy, service, adapters); `packages/dev-view/src/resources/**`; `packages/types/src/dev-runtime.ts` (#424 DTOs) | Muxy `WorktreeProcessQuiescer.swift`/`ProcessUsage.swift`; t3code `apps/server/src/usage/**`, `apps/server/src/provider/Layers/*UsageLimits.ts`, `apps/server/src/diagnostics/ProcessResourceMonitor.ts`, `apps/server/src/preview/PortScanner.ts`; Orca `src/main/memory/collector.ts`, `src/main/automations/run-usage-collection.ts` | Muxy `5c5be8697c57a2fe70cda97fdbaf7c912e2e31b6`; t3code `77bca8b2d76a1f42552e5eee7d277fcb1160347a`; Orca `403b62a8d8fa6e896a93acc4c15405be0f0b7dc7` | Donor sources were used as design evidence only; no donor source was available in the checkout and nothing was transcribed, so no donor copyright notice is carried by these files | Concept-level design evidence only: donor race-defense gaps (delayed PID escalation without start-identity fencing, PGID reuse, lsof-wide port signalling) and usage-source separation informed the Adea contract; ownership derives solely from Adea launch records plus the supervision engine's public stop API, and the configurable usage URL was rejected per the issue | Clean-room implementation of `docs/specs/dev-runtime.md` ("Process, port, metrics, and usage", "Host provider policy (M12 #424)") and the dev-runtime-operations registry; no donor test cases were copied | `apps/desktop/tests/dev-runtime-resources.test.ts`; `packages/dev-view/tests/resources-model.test.ts`; `packages/dev-view/tests/activity-model.test.ts` in issue #424 | t3code, Muxy, and Orca sections |
A row is required for copied logic even when identifiers or language change.
Package dependencies are recorded by package name/version/license rather than
source path, but still require dependency and distribution-license review.

## Required review procedure

Before implementation merges:

1. identify the smallest donor unit and all of its imports/dependencies;
2. verify the exact pinned source and license, including NOTICE and third-party
   obligations;
3. choose dependency use, adaptation, concept-only reimplementation, or reject;
4. enter copied/substantially translated units in the ledger and Adea `NOTICE`;
5. preserve copyright/license headers;
6. derive security requirements from the Adea spec, not donor defaults;
7. run provenance scans for Warp and `hexuria/opengrok`;
8. verify the final bundle has no React/Pierre runtime or accidental donor
   generated/vendor tree.
   | `apps/desktop/shell/src/dev-runtime/terminal/pty-adapter.ts` | t3code `apps/server/src/terminal/PtyAdapter.ts`; `apps/server/src/terminal/BunPtyAdapter.ts` | `77bca8b2d76a1f42552e5eee7d277fcb1160347a` | Copyright (c) 2026 T3 Tools Inc.; MIT | Translation of the adapter interface and Bun `terminal` spawn lifecycle | Replaced the donor's TextDecoder string contract with byte-preserving `Uint8Array` chunks; buffered the synchronous pre-assignment data window the donor drops; typed `unsupported_capability` at spawn instead of a construction defect; no Effect host | `apps/desktop/tests/terminal-pty-adapter.test.ts` in issue #396 | t3code section |
   | `apps/desktop/shell/src/dev-runtime/terminal/terminal-manager.ts` | bb `apps/host-daemon/src/terminals/terminal-manager.ts:20-117,423-451,698-730` | `52a9256373d4d36f9b60e9e2a7f333464091a2ac` | Copyright (c) 2026 Michael Yong; MIT | Substantial TypeScript translation of session bookkeeping, bounded scrollback, output batching, serialized per-terminal operations, and device-attributes consumption | Re-expressed at byte level (no decode/base64); added generation ownership, exactly-once replay with resync anchors, per-subscriber flow control, detach-only shutdown, and injectable limits; node-pty seams replaced with the Adea adapter | `apps/desktop/tests/terminal-manager.test.ts` in issue #396 | bb section |
   | `packages/dev-view/src/terminal/transport.ts` | bb `packages/client-core/src/terminal/terminal-websocket-transport.ts:8-107,172-303,346-394,422-434` | `52a9256373d4d36f9b60e9e2a7f333464091a2ac` | Copyright (c) 2026 Michael Yong; MIT | Substantial translation of the bounded input queue, high-water drain, capped exponential reconnect, heartbeat timeout, and suspend/resume mechanics | Replaced the donor URL/JSON/base64 attach with authenticated `terminal-bytes-v1` grants; sequence gaps invoke the explicit checkpoint resync flow instead of advancing the counter; stream-frame contract from Adea types | `packages/dev-view/tests/terminal-transport.test.ts` in issue #396 | bb section |
   | `apps/desktop/shell/src/dev-runtime/terminal/checkpoints.ts`; `apps/desktop/shell/src/dev-runtime/terminal/sidecar/service.ts` | Orca `src/main/terminal-history.ts:186-285`; `src/main/daemon/daemon-pty-checkpoint-persistence.ts`; `src/main/daemon/daemon-init.ts`; `src/main/daemon/terminal-history-*.ts` | `403b62a8d8fa6e896a93acc4c15405be0f0b7dc7` | Copyright (c) 2026 Lovecast Inc.; MIT | Adaptation of the checkpoint/append-increment model, retention GC, quarantine-with-retained-bytes recovery, and sidecar composition | Versioned length-prefixed segments with whole-file checksums; relative content-derived history identifiers replace the donor's absolute-path deletion authority, and deletion re-proves containment at call time; scope-bound hello with single-use nonces | `apps/desktop/tests/terminal-checkpoints.test.ts`; `apps/desktop/tests/terminal-sidecar.test.ts` in issue #396 | Orca section |
   | `apps/desktop/shell/src/dev-runtime/terminal/shell-integration.ts` | Orca `src/main/terminal-history.ts`; `src/main/shell-startup-features.ts:14-94`; Buzz `desktop/src-tauri/crates/buzz-terminal/src/env_fence.rs` | Orca `403b62a8d8fa6e896a93acc4c15405be0f0b7dc7`; Buzz `eed74bde2f4797714335ac10c56c0b0244c1def4` | Copyright (c) 2026 Lovecast Inc.; MIT; Copyright 2026 Block, Inc.; Apache-2.0 | Adaptation of per-worktree history env injection (check-before-set, inherited-variable stripping, fish session naming), the positive startup-feature allowlist, and the allow-never-deny spawn environment fence | Content-addressed owner-only wrappers; an independently designed authenticated OSC 133/7 observation frame (HMAC over terminal/generation/kind/nonce/digest, single-use nonces, 2 KiB payload bound, 1,000 frames/s rate bound); OSC 52 denied by default and stripped; no Warp material | `apps/desktop/tests/terminal-shell-integration.test.ts` in issue #396 | Orca and Buzz sections |
   | `packages/dev-view/src/terminal/blocks.ts` (bounded publication concept) | Buzz `desktop/src-tauri/src/terminal_transport.rs:64-178,257-380` | `eed74bde2f4797714335ac10c56c0b0244c1def4` | Copyright 2026 Block, Inc.; Apache-2.0 | Concept translation of the one-in-flight/at-most-one-pending bounded publication state machine and stale-subscription fencing | Credit and viewport fencing apply to Adea's chunk replay flow control on the host; credit is never treated as authentication, ownership, or replay authority; block UI is an independent implementation of external OSC 133/7 semantics | `apps/desktop/tests/terminal-manager.test.ts`; `packages/dev-view/tests/terminal-renderer-editor.test.ts` in issue #396 | Buzz section |
   | `apps/desktop/shell/src/dev-runtime/projects/scan.ts` | KiroCrew `src/kiro_crew/project_scan.py:1-31,1465-1662` (prune-first walker, workspace-manifest detection, ignore semantics, budget/cancellation behavior) with the donor's member/properties/fixture test ideas | `283e136c0f902e965a535a7c9548c57c7504fed0` | Copyright Amazon.com, Inc. or its affiliates; Apache-2.0 and donor `NOTICE` | Bounded TypeScript translation of the prune-first discovery semantics; the 1,662-line Python file is deliberately not translated wholesale | Replaced Python/tree-sitter seams with `node:fs` `Dirent` walkers that never follow symlinks; declared-workspace parsing for npm/pnpm/Yarn/Bun/Cargo/uv manifests via bounded line/JSON readers (no new YAML/TOML dependencies); budget exhaustion and cancellation return partial successful pages with diagnostics; scanning never executes install/bootstrap commands | `apps/desktop/tests/project-scan.test.ts` in issue #398 | KiroCrew section |
   | `packages/dev-view/src/sidebar/scan-preview-model.ts`; `packages/dev-view/src/sidebar/add-project-panel.tsx` (add/scan composition); `sidebar/dev-sidebar-shell.tsx` (add-project slot) | KiroCrew `website/src/pages/ChatSidebar.tsx` (sidebar add/search flow); Orca `src/renderer/src/components/sidebar/AddRepoDialog.tsx` (confirm-before-add preview rows with source/duplicate/authorization state) | KiroCrew `283e136c0f902e965a535a7c9548c57c7504fed0`; Orca `403b62a8d8fa6e896a93acc4c15405be0f0b7dc7` | Copyright Amazon.com, Inc. or its affiliates; Apache-2.0 and donor `NOTICE`; Copyright (c) 2026 Lovecast Inc.; MIT | Composition translation of the add surface: recent authorized roots, scan previews with package-manager and duplicate state, and confirm-before-import rows | Replaced React dialog seams with a Solid disclosure panel issuing only `dev.project.bookmarks`/`dev.project.scan`/`dev.group.list`/`dev.group.create`/`dev.project.import` commands; previews require confirmation and never execute install/bootstrap; the register's bookmark-binding check remains the authoritative duplicate refusal | `packages/dev-view/tests/scan-preview-model.test.ts`; `apps/desktop/tests/project-registry.test.ts` in issue #398 | KiroCrew and Orca sections |

The selected #532 composer IME contract is translated from KiroCrew in
[UI PR #18](https://github.com/adea-ai/ui/pull/18). Native candidate Enter retains
its default action; a post-composition commit cannot send the draft; overlapping
timers and abandoned compositions recover. Nine built component cases passed in
both Chromium and WebKit. The source/NOTICE retain the Apache attribution. This
selected guard does not establish a full donor composer port, production Chat
adoption, packed distribution certification or manual operating-system IME
acceptance; those dimensions remain pending in the traceability inventory.

The #532 plain-transcript follow contract is translated from KiroCrew's
`useChatScrollFollow.ts` and `FollowController.ts` in
[UI PR #19](https://github.com/adea-ai/ui/pull/19). Content/viewport observation,
user-versus-self scroll, directional re-engagement, scroll-event races and
content/viewport clamp distinctions replace the generic mutation-only surface.
An action-only jump label replaces the unsupported pixel-distance message
count; keyboard jumping restores focus to the transcript. Apache attribution,
exact original/destination paths and intentional virtualizer exclusions remain
in source, NOTICE, the manifest and the selected-unit inventory.

The local library suite, 49 translated core tests and 32 browser/source-SSR checks
passed. The latter cover Chromium/WebKit, light/dark and four accepted widths.
These checks do not establish packed distribution, canonical session/durable
scroll restoration, full Chat composition or either application's production
adoption. The disabled plain-follow mode is fully inert; re-enabling explicitly
re-arms at the bottom rather than automatically restoring a parked history view.

### Chat consumer continuity review

Source review at Adea commit `78a952d527cb7b7c8c8ac307da95721ddf64a8e9`
identified additional #532 migration gates. `ChatTranscript` owns a local CSS
overflow scroller; it does not mount the standalone conversation surface or bind
a scroll-restoration port. `ChatView` remounts the transcript and composer under
its canonical session/generation key. Its model port exposes transcript reads,
send and cancel, while `ChatComposer` edits a local draft signal initialized
from the conversation without writing that draft back to the model.

The repeated Dev/Chat switching test in
`packages/dev-view/tests/chat-conversation-model.test.ts` seeds `model.setDraft`
directly and compares retained event IDs/sequences and the model draft. It does
not type into a rendered composer, remount `ChatView`, inspect `scrollTop`, or
verify focus. Its scrollback assertion concerns retained events, not the rendered
viewport. Preserve that useful authority proof and add the missing rendered
continuity proof during migration; do not relabel it as end-to-end acceptance.

The shared follow controller's explicit re-arm is not a restoration protocol.
Migration must preserve an unsent typed draft, earlier-content reading position
and follow intent across repeated view switches, while retaining authenticated
scope, generation-fenced stream cleanup/resync and truthful unavailable response
controls. Returning-user production entry and packaged acceptance remain separate
gates. These are source observations, not a fresh production-route reproduction
or permission to create a second runtime authority. The corresponding selected
unit in the traceability inventory records the exact inspected paths and pending
proofs.

### Packed conversation integration pilot

An isolated UI integration branch combines the packing correction from PR #16
with the selected IME and transcript fixes from PR #18/#19. At
[commit `66950df`](https://github.com/adea-ai/ui/commit/66950dfb9197e061e49e286315a6ac3f3df3e7eb),
`bun run check:packed-conversation` installs the actual npm tarball into a clean
consumer without optional heavy peers and imports the documented conversation
subpath. Both compiled and Solid source exports pass seven check groups in each
of Chromium and WebKit (28 groups): failed-draft retention, recovered send,
native IME defaults, the post-composition latch, reader intent during streamed
text, jump focus and external Tailwind utility delivery. Packed Apache LICENSE
and both KiroCrew NOTICE sections are checked too.

The composition retains one Solid runtime and one JS chunk: 23,880/23,936 gzip JS
bytes (compiled/Solid), with 40,203 raw CSS bytes. Fixture budgets are 26 KiB gzip
JS and 42 KiB raw CSS, alongside independent unrelated-module/font exclusions.
This is a browser consumer fixture, not either application's production pipeline,
native SSR, manual OS IME acceptance, canonical restoration or full Chat adoption.

The integrated `bun run verify` **fails** its required packed root-import gate:
six cases cannot resolve the optional chart peer. Earlier format/lint/types,
141 UI tests/15,696 assertions, five workshop tests, coverage/theme/registry,
UI/Storybook builds, tree budgets and structural packing checks pass. The root
compatibility decision remains pending; the subpath pilot neither replaces that
gate nor establishes release readiness. Original fix PRs remain the merge paths;
the integration branch is retained for reviewable experiment evidence.

### Selected busy-action extraction checkpoint

[UI PR #20](https://github.com/adea-ai/ui/pull/20) translates KiroCrew's complete
`BusySendButton.tsx` and the enabled-row Tab cycle from `useMenuKeyboard.ts` at
revision `283e136c0f902e965a535a7c9548c57c7504fed0`. Both units and their nearest
tests were read in full; source copyright and Apache NOTICE are retained.
The controlled Steer/Queue picker remains available before typing while firing
is disabled, never fires on mode selection, and displays unsupported modes with
host-provided reasons. Kobalte owns maintained menu navigation and focus; the
scoped native Tab cycle preserves the donor behavior without document listeners.
Persistence, runtime authority, localization and force reset remain app-owned.

Visual inspection exposed square controls resolving `size-control-*` through
spacing tokens. Six Tailwind `--size-control-*` aliases now resolve existing
height tokens. Height utilities already worked; token values, padding and root
typography remain unchanged. Eight corrected geometry cases failed before this
fix. All 36 Chromium/WebKit cases now pass, covering keyboard/capability behavior,
light/dark at 320/768/1024/1440px, overflow/axe and six sizes in both densities.
`mise exec node@24.18.0 -- bun run verify` passes format, lint, types, unit/coverage,
theme/registry, builds and tree budgets at the PR commit.

This is selected source-component evidence, not packed consumer, full Chat
composition, manual accessibility, production adoption or runtime queue proof.
The separate packed root-export compatibility gate remains open. No application
implementation or old system is removed by this extraction.
