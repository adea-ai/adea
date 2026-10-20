import { resolve } from 'node:path'

export const LEAD_MODEL_PANE_HARNESS_PATH = '/__adea-lead-model-pane-harness'

export function leadModelPaneHarnessHtml(): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8"><title>lead model pane harness</title>',
    '<style>html, body { margin: 0; min-height: 100%; } #harness-root { min-height: 100vh; }</style>',
    '</head><body><div id="harness-root"></div></body></html>',
  ].join('')
}

export function leadModelPaneHarnessModuleSource(): string {
  const harnessPath = resolve(process.cwd(), 'apps/web/e2e/helpers/lead-model-pane-harness-app.tsx')
  if (!harnessPath.startsWith(process.cwd()))
    throw new Error('harness path escaped repository root')
  return `import '${'/@fs' + harnessPath}'`
}
