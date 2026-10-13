import { describe, expect, test } from 'bun:test'

import { workspaceAccentRoles } from '../src/components/workspace-accent'

const roles = { primary: 'p' } as never

describe('workspace accent over the shared theme context', () => {
  const calls: Array<string | null> = []
  const theme = {
    accentRolesFor: (accent: string | null) => {
      calls.push(accent)
      return roles
    },
  }

  test('asks the shared context for a preset accent', () => {
    calls.length = 0
    expect(workspaceAccentRoles('blue', theme)).toBe(roles)
    expect(calls).toEqual(['blue'])
  })

  test('asks the shared context for a custom #rrggbb accent', () => {
    calls.length = 0
    expect(workspaceAccentRoles('#336699', theme)).toBe(roles)
    expect(calls).toEqual(['#336699'])
  })

  test('keeps the inherited accent for none, a malformed accent or no provider', () => {
    calls.length = 0
    expect(workspaceAccentRoles(null, theme)).toBeUndefined()
    expect(workspaceAccentRoles('#369', theme)).toBeUndefined()
    expect(workspaceAccentRoles('not-an-accent', theme)).toBeUndefined()
    expect(workspaceAccentRoles('blue', undefined)).toBeUndefined()
    expect(calls).toEqual([])
  })
})
