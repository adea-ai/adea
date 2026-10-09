import { expect, test } from 'bun:test'
import {
  parseWorkspaceDeletion,
  workspaceDeletionOriginAllowed,
} from '../src/server/workspace-deletion-request'

const request = (origin: string, site = 'same-origin', client = '') =>
  new Request('https://adea.dev/api/workspaces/id/delete', {
    method: 'POST',
    headers: { origin, 'sec-fetch-site': site, 'x-adea-client': client },
  })

test('permanent deletion requires the current name and a positive version', () => {
  expect(parseWorkspaceDeletion({ confirmationName: 'Home', expectedVersion: 2 })).toEqual({
    confirmationName: 'Home',
    expectedVersion: 2,
  })
  for (const value of [
    null,
    {},
    { expectedVersion: 1 },
    { confirmationName: 'Home' },
    { confirmationName: '', expectedVersion: 1 },
    { confirmationName: 'Home', expectedVersion: 0 },
    { confirmationName: 'Home', expectedVersion: 1.5 },
    { confirmationName: 'Home', expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
  ])
    expect(parseWorkspaceDeletion(value)).toBeNull()
})

test('rejects cross-site deletion but allows the trusted desktop and same origin', () => {
  expect(workspaceDeletionOriginAllowed(request('https://adea.dev'))).toBe(true)
  expect(workspaceDeletionOriginAllowed(request('https://evil.example', 'cross-site'))).toBe(false)
  expect(
    workspaceDeletionOriginAllowed(request('http://127.0.0.1:4789', 'cross-site', 'desktop'))
  ).toBe(true)
  expect(workspaceDeletionOriginAllowed(request('http://127.0.0.1:4789', 'cross-site'))).toBe(false)
})

test('only the explicit preparation phase is recognized; unknown phase claims cannot finalize cleanup', () => {
  expect(
    parseWorkspaceDeletion({ confirmationName: 'Home', expectedVersion: 1, phase: 'prepare' })
  ).not.toBeNull()
  expect(
    parseWorkspaceDeletion({ confirmationName: 'Home', expectedVersion: 1, phase: 'complete' })
  ).toBeNull()
})
