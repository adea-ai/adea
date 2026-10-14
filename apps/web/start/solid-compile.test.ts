import { describe, expect, test } from 'bun:test'

import { isClientOnlySolidSource } from './solid-compile'

describe('isClientOnlySolidSource', () => {
  test('Dev View components compile for the browser only', () => {
    expect(isClientOnlySolidSource('/repo/packages/dev-view/src/history/history-pane.tsx')).toBe(
      true
    )
    expect(isClientOnlySolidSource('C:\\repo\\packages\\dev-view\\src\\utility-host.tsx')).toBe(
      true
    )
  })

  test('shared UI the server-rendered pages import stays hydratable', () => {
    for (const name of ['button', 'input', 'label', 'alert', 'typography', 'text-link']) {
      expect(
        isClientOnlySolidSource(
          `/repo/node_modules/@adea-ai/ui/src/components/ui/${name}/${name}.tsx`
        )
      ).toBe(false)
    }
    expect(isClientOnlySolidSource('/repo/packages/ui/src/components/appearance-host.tsx')).toBe(
      false
    )
  })

  test('the other shared UI components are browser-only', () => {
    expect(
      isClientOnlySolidSource('/repo/node_modules/@adea-ai/ui/src/components/ui/dialog/dialog.tsx')
    ).toBe(true)
    expect(
      isClientOnlySolidSource(
        '/repo/node_modules/@adea-ai/ui/src/components/layout/floating-preview/floating-preview.tsx?v=1'
      )
    ).toBe(true)
  })

  test('application routes, other packages and non-component files are untouched', () => {
    expect(isClientOnlySolidSource('/repo/apps/web/src/start/routes/auth/sign-in.tsx')).toBe(false)
    expect(isClientOnlySolidSource('/repo/packages/workspace-ui/src/shell.tsx')).toBe(false)
    expect(isClientOnlySolidSource('/repo/packages/dev-view/src/history/turns-model.ts')).toBe(
      false
    )
    expect(isClientOnlySolidSource('/repo/node_modules/lucide-solid/dist/source/icons/x.jsx')).toBe(
      false
    )
  })
})
