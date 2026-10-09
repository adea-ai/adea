import { describe, expect, test } from 'bun:test'

import type {
  ArtifactReferenceEvidence,
  ArtifactReferenceGrant,
  ArtifactReferenceGrantState,
  ArtifactReferenceTarget,
} from '@adea-ai/types'
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
 * Service suites for M15 #1217. A fake authorization scope stands in for the
 * #1207 lock and transaction. The trusted clock is a fake whose time a test can
 * move inside the scope, to model a lock wait. Every read is recorded in order,
 * so the suites prove that the clock is sampled after the final read and that
 * the release runs last.
 */

const CHECKSUM = 'a'.repeat(64)
const SOURCE = 'ws-source'
const DEST = 'ws-dest'
const CHANNEL = 'channel-a'
const ACTOR = 'user-actor'
const RECIPIENT = 'user-recipient'
const MESSAGE = 'message-1'
const T0 = '2026-10-08T12:00:00.000Z'
const LATER = '2026-10-08T12:01:00.000Z'

const target: ArtifactReferenceTarget = {
  artifactId: 'artifact-1',
  audienceWorkspaceId: DEST,
  checksumSha256: CHECKSUM,
  sourceWorkspaceId: SOURCE,
  version: 3,
}

const presentedGrant: ArtifactReferenceGrant = {
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

const ACTIVE: JobOutboundAudience = {
  channelId: CHANNEL,
  channelIsGroup: true,
  channelLive: true,
  joinedAt: '2026-10-01T00:00:00.000Z',
  participant: true,
  workspaceLive: true,
}

function makeWorld() {
  const world = {
    access: { role: 'owner', workspaceLive: true } as JobOutboundAccess,
    audience: ACTIVE as JobOutboundAudience,
    evidence: liveEvidence as ArtifactReferenceEvidence | null,
    job: {
      completedAt: '2026-10-08T11:00:00.000Z',
      jobId: 'job-1',
      originalActorUserId: ACTOR,
      sourceWorkspaceId: SOURCE,
    } as JobOutboundJobSource | null,
    publication: {
      artifact: null,
      artifactLinkCount: 0,
      bodyText: 'Approved body.',
      channelId: CHANNEL,
      createdAt: '2026-10-08T11:30:00.000Z',
      deleted: false,
      edited: false,
      executionRef: 'job-1',
      messageId: MESSAGE,
      senderUserId: ACTOR,
      senderKind: 'user',
      taskId: null,
      workspaceId: DEST,
    } as JobOutboundPublication | null,
    grantState: null as ArtifactReferenceGrantState | null,
    /** Runs at the start of the scope, before the first read, to model a lock wait. */
    beforeScope: undefined as undefined | (() => void),
    /** Runs after the job read, to model a change that lands between awaits. */
    afterJobRead: undefined as undefined | (() => void),
  }
  return world
}

function harness(world: ReturnType<typeof makeWorld>, options: { clockNow: () => string }) {
  const events: string[] = []
  const transaction = { id: 'tx-1' }
  const reads: JobOutboundReads = {
    async readAccess() {
      events.push('read:access')
      return world.access
    },
    async readArtifactEvidence() {
      events.push('read:evidence')
      return world.evidence
    },
    async readAudience() {
      events.push('read:audience')
      return world.audience
    },
    async readJobSource() {
      events.push('read:job')
      const job = world.job
      world.afterJobRead?.()
      return job
    },
    async readPublication() {
      events.push('read:publication')
      return world.publication
    },
  }
  const authorize: JobOutboundAuthorize<typeof transaction> = async (scope, run) => {
    events.push(scope ? 'scope:grant' : 'scope:plain')
    world.beforeScope?.()
    return run({ grantState: world.grantState, reads, transaction })
  }
  const service = createJobOutboundResultService({
    authorize,
    clock: () => {
      events.push('clock')
      return options.clockNow()
    },
    resolveDelivery: async () => resolution(world),
  })
  return { events, service, transaction }
}

function resolution(world: ReturnType<typeof makeWorld>): JobOutboundDeliveryResolution | null {
  if (!world.publication) return null
  if (!world.publication.artifact) return { claim: null, scope: null }
  return {
    claim: { authority: { kind: 'workspace_grant' }, grant: presentedGrant },
    scope: {
      artifactId: 'artifact-1',
      grantId: 'artifact-grant-1',
      revision: 1,
      sourceWorkspaceId: SOURCE,
    },
  }
}

function linkedWorld() {
  const world = makeWorld()
  world.publication = {
    ...world.publication!,
    artifact: target,
    artifactLinkCount: 1,
  }
  world.grantState = liveState
  return world
}

const deliverInput = { jobId: 'job-1', messageId: MESSAGE, recipientUserId: RECIPIENT }

describe('job outbound result service', () => {
  test('releases the canonical publication body after the reads, sampling the clock last', async () => {
    const world = makeWorld()
    const { events, service, transaction } = harness(world, { clockNow: () => T0 })
    const released: unknown[] = []
    const decision = await service.deliver(deliverInput, async (context, result) => {
      expect(context.transaction).toBe(transaction)
      released.push(result)
    })
    expect(decision).toMatchObject({ action: 'deliver', messageId: MESSAGE })
    expect(released).toEqual([{ artifact: null, jobId: 'job-1', summary: 'Approved body.' }])
    const lastRead = events.lastIndexOf('read:audience')
    expect(events.indexOf('clock')).toBeGreaterThan(lastRead)
  })

  test('delayed-lock expiry: a grant that lapses while the lock is awaited is denied', async () => {
    const world = linkedWorld()
    let now = T0
    const { service } = harness(world, { clockNow: () => now })
    // The lock is awaited for a minute; the grant expires in thirty seconds.
    world.beforeScope = () => {
      now = LATER
    }
    let released = 0
    expect(
      await service.deliver(deliverInput, async () => {
        released += 1
      })
    ).toEqual({ action: 'deny', gate: 'artifact', reason: 'grant_expired' })
    expect(released).toBe(0)
  })

  test('control: the same grant is released when the lock is granted before expiry', async () => {
    const world = linkedWorld()
    const { service } = harness(world, { clockNow: () => T0 })
    expect(await service.deliver(deliverInput, async () => {})).toMatchObject({
      action: 'deliver',
      result: { artifact: target },
    })
  })

  test('a registration revised between the unlocked resolve and the lock is refused', async () => {
    const world = linkedWorld()
    world.grantState = { ...liveState, revision: 2 }
    const { service } = harness(world, { clockNow: () => T0 })
    expect(await service.deliver(deliverInput, async () => {})).toEqual({
      action: 'deny',
      gate: 'artifact',
      reason: 'grant_revision_stale',
    })
  })

  test('cross-group substitution: a standing read for another channel never releases', async () => {
    const world = makeWorld()
    world.audience = { ...ACTIVE, channelId: 'channel-b' }
    const { service } = harness(world, { clockNow: () => T0 })
    let released = 0
    expect(
      await service.deliver(deliverInput, async () => {
        released += 1
      })
    ).toEqual({ action: 'deny', gate: 'audience', reason: 'destination_channel_mismatch' })
    expect(released).toBe(0)
  })

  test('a source revocation landing between awaited reads denies the release', async () => {
    const world = makeWorld()
    world.afterJobRead = () => {
      world.access = { role: 'member', workspaceLive: true }
    }
    const { service } = harness(world, { clockNow: () => T0 })
    let released = 0
    expect(
      await service.deliver(deliverInput, async () => {
        released += 1
      })
    ).toEqual({ action: 'deny', gate: 'source', reason: 'source_access_lost' })
    expect(released).toBe(0)
  })

  test('a missing canonical publication is refused before any scope is opened', async () => {
    const world = makeWorld()
    world.publication = null
    const { events, service } = harness(world, { clockNow: () => T0 })
    expect(await service.deliver(deliverInput, async () => {})).toMatchObject({
      action: 'deny',
      gate: 'publication',
      reason: 'publication_unavailable',
    })
    expect(events).toEqual([])
  })

  test('a failed read rejects and releases nothing', async () => {
    const world = makeWorld()
    let released = 0
    const failing = createJobOutboundResultService({
      authorize: (async (scope, run) =>
        run({
          grantState: null,
          reads: {
            readAccess: async () => world.access,
            readArtifactEvidence: async () => null,
            readAudience: async () => {
              throw new Error('audience store unavailable')
            },
            readJobSource: async () => world.job,
            readPublication: async () => world.publication,
          },
          transaction: {},
        })) as JobOutboundAuthorize<object>,
      clock: () => T0,
      resolveDelivery: async () => ({ claim: null, scope: null }),
    })
    await expect(
      failing.deliver(deliverInput, async () => {
        released += 1
      })
    ).rejects.toThrow('audience store unavailable')
    expect(released).toBe(0)
  })

  test('a release write that fails rejects the delivery', async () => {
    const world = makeWorld()
    const { service } = harness(world, { clockNow: () => T0 })
    await expect(
      service.deliver(deliverInput, async () => {
        throw new Error('write failed')
      })
    ).rejects.toThrow('write failed')
  })

  test('publish samples the clock after its reads and returns a decision without writing', async () => {
    const world = makeWorld()
    const { events, service } = harness(world, { clockNow: () => T0 })
    const decision = await service.publish({
      artifact: null,
      destination: { channelId: CHANNEL, workspaceId: DEST },
      jobId: 'job-1',
      result: { jobId: 'job-1', summary: 'Done.' },
    })
    expect(decision).toMatchObject({ action: 'publish', destination: { channelId: CHANNEL } })
    expect(events.indexOf('clock')).toBeGreaterThan(events.indexOf('read:access'))
  })

  test('the stored job is not mutated by publish or delivery', async () => {
    const world = makeWorld()
    const before = JSON.stringify(world.job)
    const { service } = harness(world, { clockNow: () => T0 })
    await service.deliver(deliverInput, async () => {})
    await service.publish({
      artifact: null,
      destination: { channelId: CHANNEL, workspaceId: DEST },
      jobId: 'job-1',
      result: { jobId: 'job-1', summary: 'Done.' },
    })
    expect(JSON.stringify(world.job)).toBe(before)
  })
})
