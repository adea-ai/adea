// Playwright entry for the source control app harness. The host page is
// isolated from the application router and the Solid harness is compiled by
// the app's Vite server through /@fs/.
import { resolve } from 'node:path'

export const SOURCE_CONTROL_HARNESS_PATH = '/__adea-source-control-harness'

export function sourceControlHarnessHtml(): string {
  return [
    '<!doctype html>',
    '<html lang="en" class="dark"><head><meta charset="utf-8"><title>Source control harness</title>',
    '<style>html,body{margin:0;height:100%;}body{display:flex;flex-direction:column;}',
    '#harness-toolbar{display:flex;align-items:center;height:3rem;padding:0 1rem;}',
    '#harness-root{flex:1;min-height:0;}</style>',
    '</head><body><div id="harness-toolbar" role="toolbar" aria-label="Workspace toolbar"></div>',
    '<div id="harness-root"></div></body></html>',
  ].join('')
}

export function sourceControlHarnessModuleSource(): string {
  const harnessPath = resolve(process.cwd(), 'apps/web/e2e/helpers/source-control-harness-app.tsx')
  if (!harnessPath.startsWith(process.cwd()))
    throw new Error('Source control harness path escaped the repository root')
  return `import '${'/@fs' + harnessPath}'`
}
