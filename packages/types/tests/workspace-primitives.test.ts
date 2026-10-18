import { describe, expect, test } from 'bun:test'
import {
  isPrincipalRef,
  isSidebarGroupMode,
  isUserPrincipalRef,
  isWorkspaceAccent,
  sidebarGroupModes,
  workspaceAccentIds,
} from '../src/index'

describe('public workspace primitive guards', () => {
  test.each([
    ['user', 'userId'],
    ['service', 'serviceId'],
    ['runtime_node', 'runtimeNodeId'],
    ['agent', 'agentId'],
    ['worker', 'workerId'],
    ['system', 'systemId'],
  ] as const)('binds %s to its exact identity field', (kind, key) => {
    const valid = { kind, [key]: 'fixture-id' }
    expect(isPrincipalRef(valid)).toBe(true)
    expect(isPrincipalRef({ kind, [key]: '  ' })).toBe(false)
    expect(isPrincipalRef({ kind, [key]: 42 })).toBe(false)
    expect(isPrincipalRef({ ...valid, permission: 'workspace.delete' })).toBe(false)
    expect(isPrincipalRef({ kind, wrongId: 'fixture-id' })).toBe(false)
    if (isPrincipalRef(valid)) expect(isUserPrincipalRef(valid)).toBe(kind === 'user')
  })

  test('refuses unsupported principals and malformed input without granting a fallback identity', () => {
    for (const value of [
      null,
      undefined,
      'user',
      {},
      [],
      { kind: 'unknown', userId: 'fixture-id' },
      { kind: 'user' },
    ])
      expect(isPrincipalRef(value)).toBe(false)
  })

  test('accepts only the persisted sidebar modes without coercion', () => {
    for (const mode of sidebarGroupModes) expect(isSidebarGroupMode(mode)).toBe(true)
    for (const value of ['Project', ' project ', '', 'all', null, 0, {}])
      expect(isSidebarGroupMode(value)).toBe(false)
  })

  test('accepts theme accents and exact lowercase RGB storage values', () => {
    for (const accent of workspaceAccentIds) expect(isWorkspaceAccent(accent)).toBe(true)
    for (const color of ['#000000', '#abcdef', '#123456'])
      expect(isWorkspaceAccent(color)).toBe(true)
    for (const value of ['#ABCDEF', '#fff', '#12345678', 'rgb(0,0,0)', '', 'red', null, 42])
      expect(isWorkspaceAccent(value)).toBe(false)
  })
})
