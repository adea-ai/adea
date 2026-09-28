// Playwright entry for the actual DevWorkspaceEntry provider path. The host
// page is isolated from the application router and the Solid harness is
// compiled by the app's Vite server through /@fs/.
import { resolve } from 'node:path'

export const DEV_WORKSPACE_RUNTIME_TERMINAL_PATH = '/__adea-dev-workspace-runtime-terminal'

export function devWorkspaceRuntimeTerminalHtml(): string {
  const xtermCss =
    '/@fs' + resolve(process.cwd(), 'packages/dev-view/node_modules/@xterm/xterm/css/xterm.css')
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><title>Dev Runtime terminal mount</title>',
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
