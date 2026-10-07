// Playwright entry for the actual DevWorkspaceEntry provider path. The host
// page is isolated from the application router and the Solid harness is
// compiled by the app's Vite server through /@fs/.
import { resolve } from 'node:path'

export const DEV_WORKSPACE_RUNTIME_TERMINAL_PATH = '/__adea-dev-workspace-runtime-terminal'

export function devWorkspaceRuntimeTerminalHtml(options?: { themeTokens?: boolean }): string {
  const xtermCss =
    '/@fs' + resolve(process.cwd(), 'packages/dev-view/node_modules/@xterm/xterm/css/xterm.css')
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><title>Dev Runtime terminal mount</title>',
    // Opt-in: the app stylesheet provides the semantic theme tokens
    // (--foreground, --muted-foreground, ...) that computed-color assertions
    // read, but its webfonts change the harness page's text metrics, so the
    // terminal runtime scenarios stay on the tokenless page they were written
    // against. Only the no-project scenario reads token colors.
    ...(options?.themeTokens ? ['<link rel="stylesheet" href="/src/start/globals.css" />'] : []),
    `<link rel="stylesheet" href="${xtermCss}" />`,
    '<style>html,body{margin:0;min-height:100%;}#harness-root{min-height:100vh;}</style>',
    '</head><body><div id="harness-root"></div></body></html>',
  ].join('')
}

export function devWorkspaceRuntimeTerminalModuleSource(): string {
  const harnessPath = resolve(
    process.cwd(),
    'apps/web/e2e/helpers/dev-workspace-runtime-terminal-app.tsx'
  )
  if (!harnessPath.startsWith(process.cwd()))
    throw new Error('Dev Runtime terminal harness path escaped the repository root')
  return `import '${'/@fs' + harnessPath}'`
}
