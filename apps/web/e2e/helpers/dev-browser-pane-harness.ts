import { resolve } from 'node:path'

export const BROWSER_PANE_HARNESS_PATH = '/__adea-browser-pane-harness'

export function browserPaneHarnessHtml(): string {
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><title>browser pane harness</title>',
    '<style>html, body, #harness-root { margin: 0; width: 100%; height: 100%; }</style>',
    '</head><body><div id="harness-root"></div></body></html>',
  ].join('')
}

export function browserPaneHarnessModuleSource(): string {
  const harnessPath = resolve(
    process.cwd(),
    'apps/web/e2e/helpers/dev-browser-pane-harness-app.tsx'
  )
  if (!harnessPath.startsWith(process.cwd())) {
    throw new Error('harness path escaped the repository root')
  }
  return `import '${'/@fs' + harnessPath}'`
}

export type BrowserPaneHarnessReport = {
  commands: readonly Readonly<{
    operation: string
    body: Readonly<Record<string, unknown>>
    resource?: Readonly<{ kind: string; id: string; generation: number }>
  }>[]
}

export type BrowserPaneHarnessControls = {
  report(): BrowserPaneHarnessReport
  deferNextScreenshot(): number
  resolveScreenshot(
    requestId: number,
    reference: import('@adea-ai/types/dev-runtime').ScreenshotRef
  ): void
  rejectScreenshot(requestId: number, error: import('@adea-ai/types/dev-runtime').DevError): void
  failNextScreenshot(error: import('@adea-ai/types/dev-runtime').DevError): void
  unmount(): void
}

declare global {
  interface Window {
    browserPaneHarness: BrowserPaneHarnessControls
  }
}
