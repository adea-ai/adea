/*
 * The desktop app-flow controllers must stay wired into the components that
 * own the interactions.
 *
 * This repository's bun lane has no DOM: no test in it mounts a Solid
 * component, and the only harness that does
 * (`apps/web/test/desktop-entry-auth-rotation.*`, driven by
 * `apps/web/e2e/native-session-inventory-auth-rotation.spec.ts`) is a browser
 * harness. The folder picker and the App Library selection rules are therefore
 * covered as controllers, not as mounted components, and this guard is what
 * keeps the components bound to those controllers: it fails when a component
 * stops delegating, which is the wiring a controller-only suite cannot see.
 *
 * The mutation control at the end proves the guard bites: each mutation
 * removes the delegation from a copy of the real source, and the guard must
 * report it.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')

const ADD_PROJECT_FORM = 'packages/dev-view/src/sidebar/add-project-form.tsx'
const WORKSPACE_NAVIGATION = 'apps/web/src/components/workspace-navigation.tsx'

/**
 * The ways the add-project form can stop using the folder-picker controller.
 */
export function pickerWiringViolations(source: string): string[] {
  const violations: string[] = []
  if (!/createProjectFolderPicker\(\{/.test(source))
    violations.push('the form does not compose the folder picker controller')
  if (!/picker\.choose\(\)/.test(source))
    violations.push('the form does not delegate the pick request to the controller')
  if (!/picker\.path\(\)/.test(source))
    violations.push('the form does not read the path from the controller')
  if (!/picker\.picking\(\)/.test(source))
    violations.push('the form does not read the pending flag from the controller')
  // A direct host call is the pre-controller implementation: it would own the
  // request rules the controller now owns.
  if (/props\.pickFolder\(\)/.test(source))
    violations.push('the form calls the host picker directly instead of the controller')
  return violations
}

/**
 * The ways the workspace navigation can stop using the App Library decisions.
 */
export function appLibraryWiringViolations(source: string): string[] {
  const violations: string[] = []
  for (const decision of [
    'appLibraryNavigationForPreferenceChange',
    'appLibraryNavigationForRequestedView',
    'appLibraryNavigationForRecovery',
  ]) {
    if (!new RegExp(`${decision}\\(`).test(source))
      violations.push(`the navigation does not use ${decision}`)
  }
  // The two inline branches the decisions replaced.
  if (/resolveWorkspaceApp\(next, requested\)/.test(source))
    violations.push('the navigation still resolves the destination inline for a recorded change')
  if (/resolveWorkspaceApp\(railPreferences\(\), nextView\)\?\.id !== nextView/.test(source))
    violations.push('the navigation still resolves a requested view inline')
  return violations
}

const addProjectForm = () => readFileSync(join(root, ADD_PROJECT_FORM), 'utf8')
const workspaceNavigation = () => readFileSync(join(root, WORKSPACE_NAVIGATION), 'utf8')

describe('desktop app-flow controller wiring', () => {
  test('the add-project form delegates the folder picker to its controller', () => {
    expect(pickerWiringViolations(addProjectForm())).toEqual([])
  })

  test('the workspace navigation delegates the App Library decisions', () => {
    expect(appLibraryWiringViolations(workspaceNavigation())).toEqual([])
  })

  test('the wiring mutation control bites: removing the delegation is reported', () => {
    // The form stops delegating the request and calls the host itself.
    const picker = addProjectForm().replace(
      'picker.choose()',
      'await props.pickFolder!().then((picked) => picked ?? undefined)'
    )
    expect(picker).not.toBe(addProjectForm())
    expect(pickerWiringViolations(picker)).toContain(
      'the form does not delegate the pick request to the controller'
    )

    // The form reads the path itself instead of the controller.
    const path = addProjectForm().replaceAll('picker.path()', 'localPath()')
    expect(path).not.toBe(addProjectForm())
    expect(pickerWiringViolations(path)).toContain(
      'the form does not read the path from the controller'
    )

    // The navigation stops using one of the decisions.
    const navigation = workspaceNavigation().replace(
      'appLibraryNavigationForRecovery(',
      'legacyRecoveryDecision('
    )
    expect(navigation).not.toBe(workspaceNavigation())
    expect(appLibraryWiringViolations(navigation)).toContain(
      'the navigation does not use appLibraryNavigationForRecovery'
    )

    // The navigation keeps the old inline branch.
    const inline = workspaceNavigation().replace(
      'appLibraryNavigationForPreferenceChange({',
      'resolveWorkspaceApp(next, requested) && appLibraryNavigationForPreferenceChange({'
    )
    expect(appLibraryWiringViolations(inline)).toContain(
      'the navigation still resolves the destination inline for a recorded change'
    )
  })
})
