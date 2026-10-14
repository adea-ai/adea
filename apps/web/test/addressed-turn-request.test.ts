import { describe, expect, test } from 'bun:test'

import {
  addressedTurnErrorResponse,
  parseAddressedTurnBody,
  parseAddressedTurnQuery,
} from '../src/server/addressed-turn-request'

const ID_A = '6f9619ff-8b86-4011-b42d-00c04fc964ff'
const ID_B = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const valid = { agentId: ID_A, dispatchRevision: 1, triggerMessageId: ID_B }

const parse = (query: string) => parseAddressedTurnQuery(new URL(`https://test/turns${query}`))
const turnError = (reason: string) =>
  Object.assign(new Error(`Addressed turn unavailable: ${reason}`), {
    name: 'AddressedTurnError',
    reason,
  })

describe('addressed turn body', () => {
  test('accepts exactly the four fields and defaults the parent to none', () => {
    expect(parseAddressedTurnBody(valid)).toEqual({ ...valid, parentTurnId: null })
    expect(parseAddressedTurnBody({ ...valid, parentTurnId: ID_B })).toMatchObject({
      parentTurnId: ID_B,
    })
    expect(parseAddressedTurnBody({ ...valid, parentTurnId: null })).toMatchObject({
      parentTurnId: null,
    })
  })

  test('refuses fields that would name the addresser, widen the budget, or add anything else', () => {
    for (const extra of [
      { addressedBy: { kind: 'user', userId: ID_A } },
      { budget: { maxDepth: 9, maxTurns: 99 } },
      { maxTurns: 99 },
      { responseMessageId: ID_A },
      { unknown: 1 },
    ])
      expect(parseAddressedTurnBody({ ...valid, ...extra })).toBeNull()
  })

  test('refuses malformed ids and revisions', () => {
    for (const bad of [
      { agentId: 'x' },
      { triggerMessageId: undefined },
      { dispatchRevision: 0 },
      { dispatchRevision: -1 },
      { dispatchRevision: 1.5 },
      { dispatchRevision: Number.MAX_SAFE_INTEGER + 1 },
      { dispatchRevision: '1' },
      { parentTurnId: 'x' },
    ])
      expect(parseAddressedTurnBody({ ...valid, ...bad })).toBeNull()
    for (const bad of [null, [], 'text', 4]) expect(parseAddressedTurnBody(bad)).toBeNull()
  })
})

describe('addressed turn query', () => {
  test('accepts an optional cursor and a bounded limit', () => {
    expect(parse('')).toEqual({})
    expect(parse(`?after=${ID_A}&limit=200`)).toEqual({ after: ID_A, limit: 200 })
    expect(parse('?limit=1')).toEqual({ limit: 1 })
  })
  test('refuses anything else', () => {
    for (const query of ['?after=x', '?limit=0', '?limit=201', '?limit=1.5', '?limit=', '?other=1'])
      expect(parse(query)).toBeNull()
  })
})

describe('addressed turn error projection', () => {
  const resolution = {
    clearTemporaryCredential: false,
    principal: { kind: 'user' as const, userId: ID_A },
    sessionRotated: false,
    temporary: true,
  }
  const request = new Request('https://test/turns')

  test('authorization and binding failures all read as the same unavailable answer', async () => {
    const answers = new Set<string>()
    for (const reason of [
      'turn_trigger_forged',
      'turn_not_participant',
      'turn_agent_revoked',
      'turn_agent_not_enlisted',
      'turn_cancel_unauthorized',
      'turn_parent_unknown',
    ]) {
      const response = addressedTurnErrorResponse(turnError(reason), resolution, request)
      expect(response.status).toBe(404)
      answers.add(await response.text())
    }
    expect(answers.size).toBe(1)
  })

  test('state conflicts are 409 with their reason, and bad input is 400', async () => {
    for (const reason of ['turn_superseded', 'turn_cancelled', 'turn_budget_exhausted']) {
      const response = addressedTurnErrorResponse(turnError(reason), resolution, request)
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ code: 'turn_conflict', reason })
    }
    for (const reason of ['turn_revision_invalid', 'turn_cursor_invalid'])
      expect(addressedTurnErrorResponse(turnError(reason), resolution, request).status).toBe(400)
  })

  test('group unavailability and unknown failures take the shared projection', () => {
    expect(
      addressedTurnErrorResponse(new Error('Channel unavailable'), resolution, request).status
    ).toBe(404)
    const original = console.error
    console.error = () => undefined
    try {
      expect(addressedTurnErrorResponse(new Error('boom'), resolution, request).status).toBe(400)
      expect(
        addressedTurnErrorResponse(turnError('turn_something_new'), resolution, request).status
      ).toBe(400)
    } finally {
      console.error = original
    }
  })
})
