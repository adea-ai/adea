// The cookie-import surface (#646) addresses three operations whose bodies are
// checked against the generated registry. A renamed field in the normative
// spec would otherwise only fail at runtime, and the commit is the sharp case:
// its body carries no lane id at all — the lane travels in the resource binding
// — so a client that spells it in the body would look right and refuse.
import { expect, test } from 'bun:test'
import { devOperationDefinitions } from '@adea-ai/types/dev-runtime'

import { buildDevCommand } from '../src/browser/command'

const scope = {
  accountId: '11111111-1111-4111-8111-111111111111',
  actorId: '11111111-1111-4111-8111-111111111111',
  nodeId: '33333333-3333-4333-8333-333333333333',
  workspaceId: '22222222-2222-4222-8222-222222222222',
}

const lane = { generation: 4, id: 'lane-1', kind: 'browser_lane' }

/** Field names the registry's body string declares, required and optional. */
function declaredFields(operation: keyof typeof devOperationDefinitions): {
  all: Set<string>
  required: Set<string>
} {
  const body = devOperationDefinitions[operation].body ?? ''
  const all = new Set<string>()
  const required = new Set<string>()
  for (const [, name, optional] of body.matchAll(/(\w+)(\?)?\s*:/g)) {
    all.add(name)
    if (!optional) required.add(name)
  }
  return { all, required }
}

const sourcesBody = {}
const planBody = {
  browserLaneId: 'lane-1',
  domains: [],
  expectedGeneration: 4,
  sourceProfileId: 'chrome:Default',
}
const commitBody = { planDigest: 'a'.repeat(64), planId: 'plan-1' }

test('every body the surface sends declares exactly the registry fields', () => {
  const cases = [
    ['dev.browser.cookieSources', sourcesBody],
    ['dev.browser.cookieImportPlan', planBody],
    ['dev.browser.cookieImportCommit', commitBody],
  ] as const

  for (const [operation, body] of cases) {
    const { all, required } = declaredFields(operation)
    const sent = new Set(Object.keys(body))
    for (const field of required) expect(sent.has(field)).toBe(true)
    for (const field of sent) expect(all.has(field)).toBe(true)
  }
})

test('the source listing binds no resource and the plan/commit pair binds the lane', () => {
  expect(devOperationDefinitions['dev.browser.cookieSources'].resource).toBeNull()

  const listing = buildDevCommand({
    body: sourcesBody,
    operation: 'dev.browser.cookieSources',
    scope,
  })
  expect(listing.resource).toBeUndefined()
  // A resource on an unbound operation, or none on a bound one, is refused
  // before the command reaches the gate.
  expect(() =>
    buildDevCommand({
      body: sourcesBody,
      operation: 'dev.browser.cookieSources',
      resource: lane,
      scope,
    })
  ).toThrow(/does not bind a resource/)

  const plan = buildDevCommand({
    body: planBody,
    operation: 'dev.browser.cookieImportPlan',
    resource: lane,
    scope,
  })
  expect(plan.resource).toEqual(lane)

  const commit = buildDevCommand({
    body: commitBody,
    operation: 'dev.browser.cookieImportCommit',
    resource: lane,
    scope,
  })
  expect(commit.resource).toEqual(lane)
  expect(Object.keys(commit.body).toSorted()).toEqual(['planDigest', 'planId'])
})
