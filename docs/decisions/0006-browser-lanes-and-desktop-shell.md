# Browser Lanes and the Engine-Bundling Desktop Shell

- Status: Accepted (2026-09-12). **Final shell selection: Electrobun 2.0.1 +
  Bun 1.4 + bundled CEF** — measured in M5.2 and locked here; see "Final
  selection" below.
- Date: 2026-09-12
- Tracks: #368 (this decision), #369 (shell benchmark), #370 (implementation),
  #371 (cleanup) — milestone M5, Desktop Shell Re-evaluation. The M5.2
  benchmark harness and its raw runs live only in PR #373's history
  (<https://github.com/adea-ai/adea/pull/373>); the milestone's final commit
  removes them, and this page is the durable record.
- Scope: desktop browser capability — agent browser-use, previews, screenshots,
  and the surface they render in. Supersedes the implicit assumption that the
  OS webview can host product browsing. The web stack in
  [0001](./0001-frontend-stack-and-scene-runtime.md) is unaffected; the
  credential discipline in [0003](./0003-local-private-content-authority.md)
  carries over into the lane identity rules below.

## Context

Browser-use is core agent utility until APIs, CLIs, and MCPs cover the flows
agents need, and every direct competitor ships a browser surface (Codex,
Cursor, Orca, Kiro Crew among them). Meanwhile the Tauri shell renders in the
OS webview — WKWebView on macOS — which cannot be an automation target: no
CDP, no headless mode, and no way to host a second engine. A seven-product
teardown (2026-09-12) found every surveyed product either embeds a full engine
(Electron `WebContentsView`/IAB, or a vendored Chromium) or attaches to the
user's real browser; none ships product browsing on the OS webview, and the
only Tauri peer surveyed (Block's Buzz) has no browser surface at all.

## Decision

Adopt a **lane-based browser architecture**:

1. **Embedded by default.** Previews (dev servers, artifact screenshots) and
   task-owned browsing run in an engine we own, rendered natively inside the
   app window.
2. **External for user context and compatibility.** When a task needs the
   user's existing authenticated context, or when a site's compatibility
   demands it, the agent drives an external browser: the user's installed
   Chrome/Edge over CDP with a dedicated automation profile, or — for the most
   hostile sites — an extension into the user's real browser with per-origin
   consent.
3. **The pane is a view onto a lane, not a browser.** Embedded lanes render
   natively in the window; external lanes render as a mirrored screencast with
   explicit, escapable input capture for human takeover (CAPTCHA, 2FA). Remote
   and web dashboards always use the mirrored transport, bound to loopback
   only.
4. **The agent's browser and the human's pane are separate browsers.** A human
   browses in the pane; an agent drives its lane's browser; takeover bridges
   the two only at explicit moments.

### Lane identity model

| Lane         | Browser + identity                                                                           | Rendering                      | Consent + lifecycle                                                           |
| ------------ | -------------------------------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------- |
| Preview      | Embedded engine, throwaway context, localhost-scoped                                         | Native pane                    | None; dies with the task                                                      |
| Task-owned   | Embedded engine, persistent per-task profile directory                                       | Native pane                    | Cookie jars are credentials: vault-stored, task-scoped, no cross-task leakage |
| User-context | External Chromium over CDP (dedicated automation profile) or extension into the real browser | Mirrored screencast + takeover | Per-origin grant on first use; never silent reuse of authenticated sessions   |

### Consequence for the desktop shell

Embedded browsing requires owning an engine, and the Tauri shell cannot host
one. The desktop shell therefore moves to an **engine-bundling candidate**:
Electron is the reference (as a thin shell over the existing local control
plane, sidecar pattern; shell-local credentials under Electron `safeStorage`),
CEF-in-Rust is the alternative that preserves a Rust core, and the remaining
candidates (Electrobun, NW.js, Deno-based, Chrome `--app`) stay in the M5.2
benchmark as longshots. Tauri is measured as the baseline that anchors the
rejection record. The measured selection lands in #370, which extends this
document with the scores rather than adding a second doc.

## Final selection (M5.2 measurements, 2026-09-12)

**Selected shell: Electrobun 2.0.1 with `mainProcess: "bun"` (Bun 1.4) and
`bundleCEF: true`.** Every candidate booted the unmodified client against the
production control plane with a real desktop session; the command surface was
served identically for every shell, so the numbers compare engine, window,
boot, and rendering cost. Same machine, same client build, cold + warm.

| Shell                          | Ready     | Workspace             | Loaded RSS (chat) | **Loaded RSS + Agent Sim scene** | App bundle |
| ------------------------------ | --------- | --------------------- | ----------------- | -------------------------------- | ---------- |
| **Electrobun + Bun + CEF**     | **1.0 s** | +1.0 s                | **350–358 MB**    | **356 MB**                       | 370 MB     |
| Electron 44                    | 4.3 s     | +1.5 s                | 533 MB            | 1,052 MB                         | 313 MB     |
| CEF-in-Rust (cef-rs)           | 0.7 s     | +1.5 s                | 905 MB            | not run                          | 330 MB     |
| NW.js                          | 0.7 s     | +1.1 s                | 970 MB            | not run                          | 404 MB     |
| Deno Desktop + CEF             | 4.0 s     | —                     | 709 MB            | not run                          | 314 MB     |
| Chrome `--app` (floor)         | 0.5 s     | +1.6 s                | 1,435–1,700 MB    | not run                          | 0          |
| Tauri 2 (no engine, reference) | 0.5 s     | can't host the scene¹ | 105 MB            | —                                | 8.9 MB     |

Why Electrobun: with the full Agent Sim world mounted it uses ~⅓ of Electron's
memory and reaches ready ~4× faster, on our own runtime (Bun is already the
repo's runtime and package manager) with an embedded Chromium. Bun 1.4's
`Bun.WebView` (which drives macOS WebKit or a local Chromium over CDP) and
`Bun.Terminal` cover the browser-use and terminal lanes from the same runtime.
The scene adds ~0 MB to its footprint and +518 MB to Electron's.

Rejected: **Electron** (fallback; scene doubles its memory, slowest first
paint), **CEF-in-Rust** (native control but 905 MB), **NW.js** (Electron's
slot, heavier), **Deno Desktop** (4.0 s startup for the same CEF cost), **Chrome
`--app`** (no shell bridge by definition), **Electrobun + Rust** (wgpu-native
surface — structurally cannot host the web client). ¹ **Tauri cannot serve the
Agent Sim pack**: desktop entitlement requires the engine manifest and entry at
the page origin (same-origin guard in `@adea-ai/spatial-protocol`) and the
engine resolves ~300 MB of world assets relative to `engine.js`; an embedded
`frontendDist` origin cannot provide them without baking the world into the
binary.

Benchmark methodology and raw runs: PR #373 history (harness deleted at
milestone closeout). Session handling used the bench's browser-type transport;
the desktop device-credential flow is implementation work shared by every
candidate and is unaffected by this selection.

**Single-UI follow-through (2026-09-13, #370):** the shell serves the web app's
own TanStack Start SPA build from loopback (`apps/web/vite.desktop.config.ts` →
`apps/web/dist-desktop/client`) and injects the bridge into that document;
desktop-only surfaces are `isDesktopRuntime()` flags in `apps/web`, not a second
client. Variant rationale and rejected alternatives: `apps/desktop/README.md`.

## Prior art (verified against installed apps, 2026-09-12)

| Product       | Shell        | Browser strategy                                                                                       |
| ------------- | ------------ | ------------------------------------------------------------------------------------------------------ |
| Cursor        | Electron     | External Chromium over CDP surfaced in an IDE tab                                                      |
| Orca          | Electron     | Embedded pane + external Chromium (agent-browser CLI/CDP) + direct cookie-DB import                    |
| ZCode         | Electron     | Embedded IAB pane + extension backend + CDP headless backend                                           |
| ChatGPT/Codex | Native Swift | Vendored Chromium embedded ("Codex Framework") + extension/AX bridge to the user's browsers            |
| Kiro Crew     | Electron     | Native `WebContentsView` pane + mirrored screencast dashboard for remote + `playwright-cli` agent lane |
| bb            | Electron     | Embedded `WebContentsView` pane, fully in-process (policy, find-in-page, history)                      |
| Buzz (Block)  | Tauri 2      | No browser surface                                                                                     |

Kiro Crew (kirodotdev/KiroCrew, `docs/system-specs/modules/browser.md`) is the
primary reference implementation: it ships both transports and documents when
each wins. The desktop pane embeds a real `WebContentsView` ("native paint,
real events, downloads, video, no letterboxing") instead of mirroring a
headless browser; web and remote clients get the mirrored screencast with
human takeover. Its control layer escalates through OS input, an in-process
`webContents.debugger` CDP session, and attach-over-CDP to the agent's
Playwright browser, with empirically recorded conflict rules.

## Alternatives considered

- **Keep Tauri; mirror an external Chromium into the window.** Rejected as the
  default pane — synthetic input, no native downloads or video, latency; the
  transport Kiro Crew demoted to remote-only. Retained as the render path for
  external lanes and remote dashboards.
- **Tauri + sidecar Chromium, no pane.** Rejected: previews and task-owned
  browsing lose the in-window surface and the annotate-to-agent UX.
- **Status quo (no browser).** Rejected: browser-use remains core agent
  utility, and the competitive set treats it as table stakes.
- **Own-Chromium native shell (Atlas-style).** Rejected for now — build cost
  out of proportion; revisit only if the CEF benchmarks fail their budgets.

## Security requirements

Implementation criteria for #370, following the Kiro Crew checklist:

- Pane webContents: no preload bridge, sandbox on, contextIsolation on,
  nodeIntegration off, webviewTag off.
- Protocol allowlist (http/https) for navigable lanes; `file:`, `data:`,
  `javascript:` rejected before load.
- Popups denied by default; the host decides external opens; popup rate
  limiting.
- Permission handlers refuse embedded lanes by webContents identity, not by
  origin heuristics, so browsed pages cannot inherit dashboard grants.
- Remote takeover surfaces bind loopback only; input capture is explicit and
  escapable.
- Cookie jars and imported storage states are credentials under the
  [0003](./0003-local-private-content-authority.md) authority: vault storage,
  per-task scoping, audit trail on import/export.

## Migration and cleanup

Benchmark harnesses live under `apps/` and are inventoried for removal in
#371. The milestone ends with one optimized shell, this document extended with
the M5.2 scores and the final selection, and no harness or migration leftovers
(grep-clean), per the milestone's end state.
