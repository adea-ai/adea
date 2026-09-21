// #422 browser/device lane DTOs. The decoders are the wire contract for the
// ADR 0006 lanes: every dev.browser.* / dev.device.* request body, success
// reply, and fail-closed shape. Cases translated from the Dev Runtime spec's
// core domain model plus the issue's hardening cases (lane crossover, stale
// generation, screenshot provenance, plan/commit pairing).
import { describe, expect, test } from 'bun:test'

import {
  decodeDevCommand,
  decodeDevReply,
  decodeDevStreamFrame,
  devOperationDecoders,
  devOperationDefinitions,
} from '../src/dev-runtime'

const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
} as const
const laneId = '00000000-0000-4000-8000-0000000000a1'
const sessionId = '00000000-0000-4000-8000-0000000000b1'
const now = '2026-09-18T12:00:00.000Z'

function command(operation: keyof typeof devOperationDefinitions, body: Record<string, unknown>) {
  const definition = devOperationDefinitions[operation]
  return {
    schemaVersion: 1,
    operation,
    requestId: '00000000-0000-4000-8000-000000000004',
    nonce: 'dGhpcy1ub25jZS1oYXMtYXQtbGVhc3QtMTI4LWJpdHM',
    issuedAt: '2026-09-15T12:00:00.000Z',
    expiresAt: '2026-09-15T12:01:00.000Z',
    scope,
    capabilities: definition.capabilities,
    ...(definition.resource
      ? {
          resource: {
            kind: definition.resource.kind,
            id: String(body[definition.resource.idField]),
            generation: Number(body.expectedGeneration ?? 1),
          },
        }
      : {}),
    body,
  }
}

function reply(operation: keyof typeof devOperationDefinitions, value: unknown) {
  return {
    schemaVersion: 1,
    operation,
    requestId: '00000000-0000-4000-8000-000000000004',
    ok: true,
    value,
    observedAt: now,
  }
}

const lane = {
  id: laneId,
  scope,
  runtimeSessionId: sessionId,
  kind: 'task_owned',
  profileId: 'profile-task-1',
  state: 'ready',
  automationOwner: 'agent',
  generation: 3,
}

const deviceSession = {
  id: '00000000-0000-4000-8000-0000000000c1',
  scope,
  runtimeSessionId: sessionId,
  inventoryId: 'device-1',
  kind: 'ios_simulator',
  state: 'attached',
  generation: 1,
}

const screenshotRef = {
  id: '00000000-0000-4000-8000-0000000000d1',
  scope,
  ownerId: laneId,
  laneKind: 'task_owned',
  profileId: 'profile-task-1',
  origin: 'https://example.test/task',
  viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
  redacted: true,
  contentType: 'image/png',
  byteLength: '1024',
  width: 1280,
  height: 720,
  sha256: 'a'.repeat(64),
  expiresAt: now,
}

const streamGrant = {
  schemaVersion: 1,
  grantId: '00000000-0000-4000-8000-0000000000e1',
  protocol: 'browser-frames-v1',
  channelId: '00000000-0000-4000-8000-0000000000e2',
  scope,
  resource: { kind: 'browser_lane', id: laneId, generation: 3 },
  direction: 'write',
  fromSequence: '0',
  expiresAt: now,
  maxFrameBytes: 65_536,
}

describe('browser lane commands', () => {
  test('decodes lane create with the ADR 0006 lane kinds', () => {
    for (const kind of ['human_embedded', 'task_owned', 'user_context'] as const) {
      expect(
        devOperationDecoders['dev.browser.laneCreate'].request({
          runtimeSessionId: sessionId,
          kind,
          profilePolicyId: 'policy-1',
        })
      ).toMatchObject({ kind })
    }
    expect(() =>
      devOperationDecoders['dev.browser.laneCreate'].request({
        runtimeSessionId: sessionId,
        kind: 'shared',
        profilePolicyId: 'policy-1',
      })
    ).toThrow('kind')
  })

  test('rejects an out-of-range viewport and a negative generation', () => {
    expect(() =>
      devOperationDecoders['dev.browser.viewport'].request({
        browserLaneId: laneId,
        expectedGeneration: 2,
        width: 8192,
        height: 720,
        deviceScaleFactor: 2,
        mobile: false,
      })
    ).toThrow('width')
    expect(() =>
      decodeDevCommand(
        command('dev.browser.navigate', {
          browserLaneId: laneId,
          expectedGeneration: -1,
          url: 'https://example.test/',
        })
      )
    ).toThrow('generation')
  })

  test('rejects a rect annotation without extents and a text annotation without text', () => {
    const base = {
      browserLaneId: laneId,
      expectedGeneration: 2,
      targetId: 'target-1',
    }
    expect(() =>
      devOperationDecoders['dev.browser.annotate'].request({
        ...base,
        annotation: { targetId: 'target-1', kind: 'rect', x: 0.1, y: 0.1 },
      })
    ).toThrow('rect')
    expect(() =>
      devOperationDecoders['dev.browser.annotate'].request({
        ...base,
        annotation: { targetId: 'target-1', kind: 'text', x: 0.1, y: 0.1 },
      })
    ).toThrow('text')
    expect(
      devOperationDecoders['dev.browser.annotate'].request({
        ...base,
        annotation: { targetId: 'target-1', kind: 'rect', x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
      })
    ).toMatchObject({ annotation: { kind: 'rect' } })
  })

  test('binds the resource to the lane id and the expected generation', () => {
    expect(() =>
      decodeDevCommand(
        command('dev.browser.navigate', {
          browserLaneId: laneId,
          expectedGeneration: 2,
          url: 'https://example.test/',
        })
      )
    ).not.toThrow()
    const crossover = command('dev.browser.navigate', {
      browserLaneId: laneId,
      expectedGeneration: 2,
      url: 'https://example.test/',
    })
    ;(crossover.resource as { generation: number }).generation = 9
    expect(() => decodeDevCommand(crossover)).toThrow('resource')
  })

  test('caps the cookie import domain list at 128 entries', () => {
    const domains = Array.from({ length: 128 }, (_, index) => `example${index}.test`)
    expect(
      devOperationDecoders['dev.browser.cookieImportPlan'].request({
        browserLaneId: laneId,
        expectedGeneration: 2,
        sourceProfileId: 'source-profile',
        domains,
      })
    ).toMatchObject({ domains })
    expect(() =>
      devOperationDecoders['dev.browser.cookieImportPlan'].request({
        browserLaneId: laneId,
        expectedGeneration: 2,
        sourceProfileId: 'source-profile',
        domains: [...domains, 'one-too-many.test'],
      })
    ).toThrow('domains')
  })

  test('pairs the cookie import commit with its plan digest', () => {
    expect(
      devOperationDecoders['dev.browser.cookieImportCommit'].request({
        planId: '00000000-0000-4000-8000-0000000000f1',
        planDigest: 'b'.repeat(64),
      })
    ).toMatchObject({ planId: '00000000-0000-4000-8000-0000000000f1' })
    expect(() =>
      devOperationDecoders['dev.browser.cookieImportCommit'].request({
        planId: '00000000-0000-4000-8000-0000000000f1',
        planDigest: 'not-a-digest',
      })
    ).toThrow('sha256')
  })
})

function gestureFrame(gesture: unknown) {
  return { type: 'gesture', sequence: '1', generation: 1, gesture }
}

describe('device session commands', () => {
  test('decodes start bound to a verified inventory id', () => {
    const decoded = decodeDevCommand(
      command('dev.device.start', {
        inventoryId: 'device-1',
        expectedGeneration: 1,
        runtimeSessionId: sessionId,
      })
    )
    expect(decoded.resource).toMatchObject({ kind: 'device_inventory', id: 'device-1' })
  })

  test('constrains device gestures to the spec ranges on the stream', () => {
    expect(() => decodeDevStreamFrame(gestureFrame({ kind: 'tap', x: 0.5, y: 0.5 }))).not.toThrow()
    expect(() => decodeDevStreamFrame(gestureFrame({ kind: 'tap', x: 1.5, y: 0.5 }))).toThrow('x')
    expect(() =>
      decodeDevStreamFrame(
        gestureFrame({ kind: 'swipe', fromX: 0, fromY: 0, toX: 1, toY: 1, durationMs: 5 })
      )
    ).toThrow('durationMs')
    expect(() =>
      decodeDevStreamFrame(
        gestureFrame({ kind: 'swipe', fromX: 0, fromY: 0, toX: 1, toY: 1, durationMs: 300 })
      )
    ).not.toThrow()
    expect(() =>
      decodeDevStreamFrame(gestureFrame({ kind: 'text', text: 'x'.repeat(4097) }))
    ).toThrow('text')
  })

  test('decodes inventory and session pages', () => {
    const inventoryReply = reply('dev.device.list', {
      items: [
        {
          id: 'device-1',
          kind: 'ios_simulator',
          name: 'iPhone 16',
          platform: 'ios',
          state: 'available',
          generation: 0,
          observedAt: now,
        },
      ],
      observedAt: now,
    })
    expect((decodeDevReply(inventoryReply) as { value: unknown }).value).toMatchObject({
      items: [{ name: 'iPhone 16' }],
    })
    const sessionReply = reply('dev.device.sessions', {
      items: [deviceSession],
      observedAt: now,
    })
    expect((decodeDevReply(sessionReply) as { value: unknown }).value).toMatchObject({
      items: [{ kind: 'ios_simulator' }],
    })
  })
})

describe('browser lane replies', () => {
  test('decodes lane lifecycle replies', () => {
    for (const operation of [
      'dev.browser.laneCreate',
      'dev.browser.laneClose',
      'dev.browser.takeover',
      'dev.browser.release',
      'dev.browser.viewport',
      'dev.browser.profileReset',
    ] as const) {
      expect((decodeDevReply(reply(operation, lane)) as { value: unknown }).value).toMatchObject({
        kind: 'task_owned',
      })
    }
    const lanes = reply('dev.browser.lanes', { items: [lane], nextCursor: 'c', observedAt: now })
    expect((decodeDevReply(lanes) as { value: unknown }).value).toMatchObject({
      items: [{ profileId: 'profile-task-1' }],
    })
  })

  test('rejects a lane with an unknown automation owner (fail closed)', () => {
    const bad = reply('dev.browser.laneCreate', { ...lane, automationOwner: 'everyone' })
    expect(() => decodeDevReply(bad)).toThrow('automationOwner')
  })

  test('decodes targets, navigation, inspection, and diagnostics', () => {
    expect(
      (
        decodeDevReply(
          reply('dev.browser.targets', {
            items: [
              {
                id: 'target-1',
                browserLaneId: laneId,
                type: 'page',
                url: 'https://example.test/',
                title: 'Example',
                generation: 3,
              },
            ],
            observedAt: now,
          })
        ) as { value: unknown }
      ).value
    ).toMatchObject({ items: [{ type: 'page' }] })
    expect(
      (
        decodeDevReply(
          reply('dev.browser.navigate', {
            browserLaneId: laneId,
            targetId: 'target-1',
            finalUrl: 'https://example.test/',
            status: 200,
            generation: 3,
            observedAt: now,
          })
        ) as { value: unknown }
      ).value
    ).toMatchObject({ status: 200 })
    expect(
      (
        decodeDevReply(
          reply('dev.browser.inspect', {
            targetId: 'target-1',
            role: 'button',
            name: 'Submit',
            bounds: { x: 1, y: 2, width: 30, height: 20 },
            observedAt: now,
          })
        ) as { value: unknown }
      ).value
    ).toMatchObject({ role: 'button' })
    expect(
      (
        decodeDevReply(
          reply('dev.browser.diagnostics', {
            items: [
              {
                id: 'd1',
                level: 'error',
                category: 'console',
                message: 'uncaught',
                observedAt: now,
              },
            ],
            observedAt: now,
          })
        ) as { value: unknown }
      ).value
    ).toMatchObject({ items: [{ category: 'console' }] })
  })

  test('decodes annotations, screenshots, cookie results, plans, and stream grants', () => {
    expect(
      (
        decodeDevReply(
          reply('dev.browser.annotate', {
            targetId: 'target-1',
            kind: 'point',
            x: 0.5,
            y: 0.5,
            id: '00000000-0000-4000-8000-0000000000a2',
            screenshotId: 'shot-1',
            createdAt: now,
          })
        ) as { value: unknown }
      ).value
    ).toMatchObject({ kind: 'point' })
    expect(
      (decodeDevReply(reply('dev.browser.screenshot', screenshotRef)) as { value: unknown }).value
    ).toMatchObject({ contentType: 'image/png' })
    expect(
      (
        decodeDevReply(
          reply('dev.device.screenshot', {
            ...screenshotRef,
            ownerId: '00000000-0000-4000-8000-0000000000c1',
          })
        ) as { value: unknown }
      ).value
    ).toMatchObject({ width: 1280 })
    expect(
      (
        decodeDevReply(
          reply('dev.browser.cookieImportCommit', {
            browserLaneId: laneId,
            imported: 4,
            skipped: 1,
            rolledBack: false,
            observedAt: now,
          })
        ) as { value: unknown }
      ).value
    ).toMatchObject({ imported: 4 })
    expect(
      (
        decodeDevReply(
          reply('dev.browser.cookieImportPlan', {
            id: '00000000-0000-4000-8000-0000000000f1',
            operation: 'dev.browser.cookieImportPlan',
            scope,
            resource: { kind: 'browser_lane', id: laneId, generation: 3 },
            factVersions: { jar: 'v1' },
            steps: [{ id: 's1', kind: 'stage', targetId: laneId, dependsOn: [] }],
            blockers: [],
            requiredApprovalIds: [],
            digest: 'c'.repeat(64),
            expiresAt: now,
          })
        ) as { value: unknown }
      ).value
    ).toMatchObject({ operation: 'dev.browser.cookieImportPlan' })
    expect(
      (decodeDevReply(reply('dev.browser.input', streamGrant)) as { value: unknown }).value
    ).toMatchObject({ protocol: 'browser-frames-v1' })
    expect(
      (
        decodeDevReply(
          reply('dev.device.attach', {
            ...streamGrant,
            protocol: 'device-frames-v1',
            resource: {
              kind: 'device_session',
              id: '00000000-0000-4000-8000-0000000000c1',
              generation: 1,
            },
            direction: 'read',
          })
        ) as { value: unknown }
      ).value
    ).toMatchObject({ protocol: 'device-frames-v1' })
  })

  test('rejects a screenshot ref with a non-canonical byte length', () => {
    expect(() =>
      decodeDevReply(reply('dev.browser.screenshot', { ...screenshotRef, byteLength: '12 KB' }))
    ).toThrow('byteLength')
    expect(() =>
      decodeDevReply(reply('dev.browser.screenshot', { ...screenshotRef, sha256: 'zz' }))
    ).toThrow('sha256')
  })

  test('rejects a cookie import result that claims success without a rolledBack flag', () => {
    expect(() =>
      decodeDevReply(
        reply('dev.browser.cookieImportCommit', {
          browserLaneId: laneId,
          imported: 1,
          skipped: 0,
          rolledBack: 'no',
          observedAt: now,
        })
      )
    ).toThrow('rolledBack')
  })
})
