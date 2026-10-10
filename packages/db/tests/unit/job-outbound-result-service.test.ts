import { describe, expect, test } from 'bun:test'

import type {
  ArtifactReferenceEvidence,
  ArtifactReferenceGrant,
  ArtifactReferenceGrantState,
  ArtifactReferenceTarget,
} from '@adea-ai/types'
import {
  encodeJobOutboundBinding,
  jobOutboundMessageKey,
  summarySha256,
  type JobOutboundBinding,
} from '../../src/job-outbound-binding'
import type {
  JobOutboundAccess,
  JobOutboundAudience,
  JobOutboundJobSource,
  JobOutboundPublication,
} from '../../src/job-outbound-result-policy'
import {
  createJobOutboundResultService,
  type JobOutboundAuthorize,
  type JobOutboundDeliveryResolution,
  type JobOutboundReads,
} from '../../src/job-outbound-result-service'

/**
 * Service suites for M15 #1217. A fake authorization scope stands in for the #1207
 * lock and the transaction. The publication write runs inside the scope, so a test
 * can check that a write is made only for an authorized publish and that it shares
 * the scope's transaction. The clock is sampled inside the scope, after the reads,
 * and each read is recorded so the order can be asserted.
 */

const CHECKSUM = 'a'.repeat(64)
const SOURCE = 'ws-source'
const DEST = 'ws-dest'
const CHANNEL = 'channel-a'
const ACTOR = 'user-actor'
const RECIPIENT = 'user-recipient'
const MESSAGE = 'message-1'
const SUMMARY = 'Approved body.'
const T0 = '2026-10-08T12:00:00.000Z'
const LATER = '2026-10-08T12:01:00.000Z'

const destination = { channelId: CHANNEL, workspaceId: DEST }

const grantRecord: ArtifactReferenceGrant = {
  artifactId: 'artifact-1',
  audienceWorkspaceId: DEST,
  checksumSha256: CHECKSUM,
  expiresAt: '2026-10-08T12:00:30.000Z',
  grantId: 'artifact-grant-1',
  revokedAt: null,
  revision: 1,
  sourceWorkspaceId: SOURCE,
  version: 3,
}

const liveState: ArtifactReferenceGrantState = {
  artifactId: 'artifact-1',
  audienceWorkspaceIds: [DEST],
  checksumSha256: CHECKSUM,
  expiresAt: '2026-10-08T12:00:30.000Z',
  grantId: 'artifact-grant-1',
  revoked: false,
  revision: 1,
  sourceWorkspaceId: SOURCE,
  version: 3,
}

const liveEvidence: ArtifactReferenceEvidence = {
  availability: 'available',
  checksumSha256: CHECKSUM,
  deletionState: 'active',
  id: 'artifact-1',
  sensitivity: 'workspace',
  version: 3,
  workspaceId: SOURCE,
}

const artifactTarget: ArtifactReferenceTarget = {
  artifactId: 'artifact-1',
  audienceWorkspaceId: DEST,
  checksumSha256: CHECKSUM,
  sourceWorkspaceId: SOURCE,
  version: 3,
}

function binding(overrides: Partial<JobOutboundBinding> = {}): JobOutboundBinding {
  return {
    actorUserId: ACTOR,
    artifact: null,
    channelId: CHANNEL,
    channelVersion: 4,
    grant: null,
    jobId: 'job-1',
    summarySha256: summarySha256(SUMMARY),
    workspaceId: DEST,
    ...overrides,
  }
}

const ACTIVE: JobOutboundAudience = {
  channelId: CHANNEL,
  channelIsGroup: true,
  channelLive: true,
  channelVersion: 4,
  participant: true,
  workspaceLive: true,
  workspaceRole: 'member',
}

type World = {
  access: JobOutboundAccess
  audience: JobOutboundAudience
  evidence: ArtifactReferenceEvidence | null
  job: JobOutboundJobSource | null
  publication: JobOutboundPublication | null
  grantState: ArtifactReferenceGrantState | null
  /** Runs before the scope's first read, to model a lock wait. */
  beforeScope?: () => void
  /** Runs after the job read, to model a change between awaits. */
  afterJobRead?: () => void
  /** Makes the publication write fail. */
  writeFails?: boolean
}

function world(overrides: Partial<World> = {}): World {
  return {
    access: { role: 'owner', workspaceLive: true },
    audience: ACTIVE,
    evidence: liveEvidence,
    grantState: null,
    job: {
      completedAt: '2026-10-08T11:00:00.000Z',
      jobId: 'job-1',
      originalActorUserId: ACTOR,
      sourceWorkspaceId: SOURCE,
    },
    publication: {
      artifact: null,
      artifactLinkCount: 0,
      bodyText: SUMMARY,
      channelId: CHANNEL,
      deleted: false,
      edited: false,
      executionRef: 'job-1',
      idempotencyKey: jobOutboundMessageKey(binding()),
      messageId: MESSAGE,
      senderKind: 'system',
      senderSystemId: encodeJobOutboundBinding(binding()),
      workspaceId: DEST,
    },
    ...overrides,
  }
}

function linkedWorld(overrides: Partial<World> = {}): World {
  const linkedBinding = binding({
    artifact: artifactBinding(),
    grant: { grantId: 'artifact-grant-1', revision: 1 },
  })
  return world({
    grantState: liveState,
    publication: {
      ...world().publication!,
      artifact: artifactTarget,
      artifactLinkCount: 1,
      idempotencyKey: jobOutboundMessageKey(linkedBinding),
      senderSystemId: encodeJobOutboundBinding(linkedBinding),
    },
    ...overrides,
  })
}

function artifactBinding() {
  return {
    artifactId: 'artifact-1',
    checksumSha256: CHECKSUM,
    sourceWorkspaceId: SOURCE,
    version: 3,
  }
}

function harness(state: World, now: () => string = () => T0) {
  const events: string[] = []
  const transaction = { id: 'tx-1' }
  const writes: Array<{ transaction: unknown; messageId: string }> = []
  const reads: JobOutboundReads = {
    async readAccess() {
      events.push('read:access')
      return state.access
    },
    async readArtifactEvidence() {
      events.push('read:evidence')
      return state.evidence
    },
    async readAudience() {
      events.push('read:audience')
      return state.audience
    },
    async readJobSource() {
      events.push('read:job')
      const job = state.job
      state.afterJobRead?.()
      return job
    },
    async readPublication() {
      events.push('read:publication')
      return state.publication
    },
  }
  const authorize: JobOutboundAuthorize<typeof transaction> = async (scope, run) => {
    events.push(scope ? 'scope:grant' : 'scope:plain')
    state.beforeScope?.()
    return run({ grantState: state.grantState, reads, transaction })
  }
  const service = createJobOutboundResultService({
    authorize,
    clock: () => {
      events.push('clock')
      return now()
    },
    resolveDelivery: async (): Promise<JobOutboundDeliveryResolution | null> => {
      if (!state.publication) return null
      const row = state.publication
      const decoded = row.senderSystemId?.length ? row.senderSystemId : null
      if (!decoded) return null
      if (!state.publication.artifact) return { claim: null, scope: null }
      return {
        claim: { authority: { kind: 'workspace_grant' }, grant: grantRecord },
        scope: {
          artifactId: 'artifact-1',
          grantId: 'artifact-grant-1',
          revision: 1,
          sourceWorkspaceId: SOURCE,
        },
      }
    },
  })
  const write = async (
    { transaction: tx }: { transaction: unknown },
    _decision: { binding: JobOutboundBinding }
  ) => {
    events.push('write')
    if (state.writeFails) throw new Error('write failed')
    writes.push({ transaction: tx, messageId: MESSAGE })
    return MESSAGE
  }
  return { events, service, transaction, writes, write }
}

const deliverInput = { jobId: 'job-1', messageId: MESSAGE, recipientUserId: RECIPIENT }
const publishInput = {
  artifact: null,
  destination,
  jobId: 'job-1',
  result: { jobId: 'job-1', summary: SUMMARY },
}

describe('job outbound result service', () => {
  test('publish writes the canonical message inside the scope, after the reads, and returns its id', async () => {
    const state = world()
    const h = harness(state)
    const result = await h.service.publish(publishInput, h.write)
    expect(result).toMatchObject({ decision: { action: 'publish' }, messageId: MESSAGE })
    expect(h.writes[0]!.transaction).toBe(h.transaction)
    expect(h.events.indexOf('write')).toBeGreaterThan(h.events.indexOf('clock'))
    expect(h.events.indexOf('clock')).toBeGreaterThan(h.events.lastIndexOf('read:audience'))
  })

  test('a held publish writes nothing: no message exists for an unauthorized publication', async () => {
    const state = world({ access: { role: 'member', workspaceLive: true } })
    const h = harness(state)
    const result = await h.service.publish(publishInput, h.write)
    expect(result).toMatchObject({
      decision: { action: 'hold', reason: 'source_access_lost' },
      messageId: null,
    })
    expect(h.writes).toEqual([])
    expect(h.events).not.toContain('write')
  })

  test('a failed publication write rejects, so nothing is committed and no id is returned', async () => {
    const state = world({ writeFails: true })
    const h = harness(state)
    await expect(h.service.publish(publishInput, h.write)).rejects.toThrow('write failed')
  })

  test('delivery releases the approved body after the final reads, sampling the clock last', async () => {
    const state = world()
    const h = harness(state)
    const released: unknown[] = []
    const decision = await h.service.deliver(deliverInput, async ({ transaction }, result) => {
      expect(transaction).toBe(h.transaction)
      released.push(result)
    })
    expect(decision).toMatchObject({ action: 'deliver', messageId: MESSAGE })
    expect(released).toEqual([{ artifact: null, jobId: 'job-1', summary: SUMMARY }])
    expect(h.events.indexOf('clock')).toBeGreaterThan(h.events.lastIndexOf('read:audience'))
  })

  test('delayed-lock expiry: a grant that lapses while the lock is awaited is denied', async () => {
    let now = T0
    const state = linkedWorld({ beforeScope: () => (now = LATER) })
    const h = harness(state, () => now)
    let released = 0
    expect(
      await h.service.deliver(deliverInput, async () => {
        released += 1
      })
    ).toEqual({ action: 'deny', gate: 'artifact', reason: 'grant_expired' })
    expect(released).toBe(0)
  })

  test('control: the same grant is released when the lock is granted before expiry', async () => {
    const h = harness(linkedWorld(), () => T0)
    expect(await h.service.deliver(deliverInput, async () => {})).toMatchObject({
      action: 'deliver',
      result: { artifact: artifactTarget },
    })
  })

  test('a registration revised between the unlocked resolve and the lock is refused', async () => {
    const h = harness(linkedWorld({ grantState: { ...liveState, revision: 2 } }))
    expect(await h.service.deliver(deliverInput, async () => {})).toEqual({
      action: 'deny',
      gate: 'artifact',
      reason: 'grant_revision_stale',
    })
  })

  test('a revocation landing between awaited reads denies the release', async () => {
    const state = world()
    state.afterJobRead = () => {
      state.access = { role: 'member', workspaceLive: true }
    }
    const h = harness(state)
    let released = 0
    expect(
      await h.service.deliver(deliverInput, async () => {
        released += 1
      })
    ).toEqual({ action: 'deny', gate: 'source', reason: 'source_access_lost' })
    expect(released).toBe(0)
  })

  test('a missing publication is refused before any scope is opened', async () => {
    const h = harness(world({ publication: null }))
    expect(await h.service.deliver(deliverInput, async () => {})).toMatchObject({
      action: 'deny',
      gate: 'publication',
      reason: 'publication_unavailable',
    })
    expect(h.events).toEqual([])
  })

  test('a failed read rejects delivery and releases nothing', async () => {
    const state = world()
    const failing = createJobOutboundResultService({
      authorize: (async (scope, run) =>
        run({
          grantState: null,
          reads: {
            readAccess: async () => state.access,
            readArtifactEvidence: async () => null,
            readAudience: async () => {
              throw new Error('audience store unavailable')
            },
            readJobSource: async () => state.job,
            readPublication: async () => state.publication,
          },
          transaction: {},
        })) as JobOutboundAuthorize<object>,
      clock: () => T0,
      resolveDelivery: async () => ({ claim: null, scope: null }),
    })
    let released = 0
    await expect(
      failing.deliver(deliverInput, async () => {
        released += 1
      })
    ).rejects.toThrow('audience store unavailable')
    expect(released).toBe(0)
  })

  test('a release write that fails rejects the delivery', async () => {
    const h = harness(world())
    await expect(
      h.service.deliver(deliverInput, async () => {
        throw new Error('release failed')
      })
    ).rejects.toThrow('release failed')
  })

  test('the stored publication and job are not mutated by publish or delivery', async () => {
    const state = world()
    const before = JSON.stringify([state.job, state.publication])
    const h = harness(state)
    await h.service.publish(publishInput, h.write)
    await h.service.deliver(deliverInput, async () => {})
    expect(JSON.stringify([state.job, state.publication])).toBe(before)
  })
})

describe('artifact omission at the service boundary (#1217 root review)', () => {
  test('an omitted artifact publishes the summary through the same atomic write, with no artifact identity', async () => {
    const state = linkedWorld({ grantState: { ...liveState, revoked: true } })
    const h = harness(state)
    const writtenBindings: unknown[] = []
    const write = async (_context: { transaction: unknown }, decision: { binding: unknown }) => {
      writtenBindings.push(decision.binding)
      return MESSAGE
    }
    const result = await h.service.publish(
      {
        artifact: { authority: { kind: 'workspace_grant' }, grant: grantRecord },
        artifactPolicy: 'omit_unauthorized',
        destination,
        jobId: 'job-1',
        result: { artifact: artifactTarget, jobId: 'job-1', summary: SUMMARY },
      },
      write
    )
    expect(result).toMatchObject({
      decision: { action: 'publish', artifactOmitted: 'grant_revoked' },
      messageId: MESSAGE,
    })
    expect(writtenBindings).toHaveLength(1)
    expect(JSON.stringify(writtenBindings)).not.toContain('artifact-1')
    expect(JSON.stringify(writtenBindings)).not.toContain('artifact-grant-1')
  })
})
