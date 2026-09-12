# Browser Lanes and the Engine-Bundling Desktop Shell

- Status: Accepted for M5.1 (2026-09-12). The final shell selection (Electron
  vs CEF-based candidates) is deferred to the M5.2 benchmarks and will be
  recorded here alongside the measured scores.
- Date: 2026-09-12
- Tracks: #368 (this decision), #369 (shell benchmark), #370 (implementation),
  #371 (cleanup) — milestone M5, Desktop Shell Re-evaluation.
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
