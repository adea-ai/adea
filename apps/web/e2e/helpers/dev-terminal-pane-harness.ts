// Spec-side half of the #538 terminal-pane Playwright harness. Playwright
// imports only this file; the Solid harness itself
// (dev-terminal-pane-harness-app.tsx) is loaded by the BROWSER through the
// app's own Vite dev server via /@fs/, so the real TerminalPane compiles with
// vite-plugin-solid exactly like application code.
import { resolve } from 'node:path'

/** Intercepted harness page path; never hits the application router. */
export const TERMINAL_PANE_HARNESS_PATH = '/__adea-terminal-pane-harness'

/** Minimal host page: a sized root for the pane, nothing else. */
export function terminalPaneHarnessHtml(): string {
  // xterm's structural stylesheet is a dependency of @adea-ai/dev-view, not of
  // the web app, so the page loads it straight from the package tree.
  const xtermCss =
    '/@fs' + resolve(process.cwd(), 'packages/dev-view/node_modules/@xterm/xterm/css/xterm.css')
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><title>terminal pane harness</title>',
    `<link rel="stylesheet" href="${xtermCss}" />`,
    '<style>',
    'html, body { margin: 0; height: 100%; }',
    '#harness-root { width: 100vw; height: 70vh; }',
    '</style></head>',
    '<body><div id="harness-root"></div></body></html>',
  ].join('')
}

/**
 * Module source that imports the Solid harness through Vite. The caller's
 * working directory is the repository root (the playwright config lives
 * there), so the helper resolves relative to it.
 */
export function terminalPaneHarnessModuleSource(): string {
  const harnessPath = resolve(
    process.cwd(),
    'apps/web/e2e/helpers/dev-terminal-pane-harness-app.tsx'
  )
  if (!harnessPath.startsWith(process.cwd())) {
    throw new Error('harness path escaped the repository root')
  }
  return `import '${'/@fs' + harnessPath}'`
}

/** Convenience for assertions that read the harness report. */
export type TerminalPaneHarnessReport = {
  generation: number
  sockets: number
  restarts: number
  dataFramesEmitted: number
  inputsByGeneration: Record<string, string[]>
  resizes: Array<{ cols: number; rows: number; generation: number }>
  copies: string[]
}
