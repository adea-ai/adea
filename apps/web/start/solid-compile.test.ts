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

  test('the workspace route’s own components compile for the browser only', () => {
    expect(isClientOnlySolidSource('/repo/packages/workspace-ui/src/shell.tsx')).toBe(true)
    expect(isClientOnlySolidSource('/repo/packages/workspace-nav/src/nav.tsx')).toBe(true)
    expect(isClientOnlySolidSource('/repo/apps/web/src/components/workspace-navigation.tsx')).toBe(
      true
    )
  })

  test('the pages the server renders and the client adopts stay hydratable', () => {
    for (const name of ['sign-in-form', 'accept-invitation', 'desktop-auth-complete'])
      expect(isClientOnlySolidSource(`/repo/apps/web/src/components/${name}.tsx`)).toBe(false)
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
    expect(isClientOnlySolidSource('/repo/packages/workspace-ui/src/shell.ts')).toBe(false)
    expect(isClientOnlySolidSource('/repo/packages/dev-view/src/history/turns-model.ts')).toBe(
      false
    )
    expect(isClientOnlySolidSource('/repo/node_modules/lucide-solid/dist/source/icons/x.jsx')).toBe(
      false
    )
  })
})
