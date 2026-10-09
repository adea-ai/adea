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
  JobOutboundDestination,
  JobOutboundJobSource,
} from '../../src/job-outbound-result-policy'
import {
  createJobOutboundResultService,
  type JobOutboundAuthorize,
  type JobOutboundReads,
} from '../../src/job-outbound-result-service'

/**
 * Service suites for M15 #1217. A fake authorization scope stands in for the
 * #1207 grant lock and the transaction. Every read goes through that scope, and
 * the release runs inside it, so the suites prove that the final authority check
 * precedes the release, and that a change between awaits is seen.
 */

const CHECKSUM = 'a'.repeat(64)
const SOURCE = 'ws-source'
const DEST = 'ws-dest'
const CHANNEL = 'channel-a'
const ACTOR = 'user-actor'
const RECIPIENT = 'user-recipient'
const NOW = '2026-10-08T12:00:00.000Z'
const destination: JobOutboundDestination = { channelId: CHANNEL, workspaceId: DEST }

const target: ArtifactReferenceTarget = {
  artifactId: 'artifact-1',
  audienceWorkspaceId: DEST,
  checksumSha256: CHECKSUM,
  sourceWorkspaceId: SOURCE,
  version: 3,
}

const artifactGrant: ArtifactReferenceGrant = {
  artifactId: 'artifact-1',
  audienceWorkspaceId: DEST,
  checksumSha256: CHECKSUM,
  expiresAt: null,
  grantId: 'artifact-grant-1',
  revokedAt: null,
  revision: 1,
  sourceWorkspaceId: SOURCE,
  version: 3,
}

const liveGrantState: ArtifactReferenceGrantState = {
  artifactId: 'artifact-1',
  audienceWorkspaceIds: [DEST],
  checksumSha256: CHECKSUM,
  expiresAt: null,
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

type Store = {
  access: Map<string, JobOutboundAccess>
  audience: Map<string, JobOutboundAudience>
  evidence: ArtifactReferenceEvidence | null
  job: JobOutboundJobSource | null
  /** Runs after the job read resolves, to model a change that lands between awaits. */
  afterJobRead?: () => void
}

function makeStore(): Store {
  return {
    access: new Map([[`${SOURCE}:${ACTOR}`, { role: 'owner', workspaceLive: true }]]),
    audience: new Map([
      [
        `${CHANNEL}:${RECIPIENT}`,
        {
          channelId: CHANNEL,
          channelIsGroup: true,
          channelLive: true,
          participant: true,
          workspaceLive: true,
        },
      ],
    ]),
    evidence: liveEvidence,
    job: {
      completedAt: '2026-10-08T11:00:00.000Z',
      jobId: 'job-1',
      originalActorUserId: ACTOR,
      sourceWorkspaceId: SOURCE,
    },
  }
}

/**
 * A scope that reads from the store and passes `grantState` through as the
 * registration under the grant lock. It records each scope it opens and each read.
 */
function fakeAuthorize(store: Store, grantState: ArtifactReferenceGrantState | null) {
  const scopes: Array<{ scope: unknown; transaction: unknown }> = []
  const reads: string[] = []
  const transaction = { id: 'tx-1' }
  const readsFor = (): JobOutboundReads => ({
    async readAccess({ userId, workspaceId }) {
      reads.push('access')
      return store.access.get(`${workspaceId}:${userId}`) ?? { role: null, workspaceLive: false }
    },
    async readArtifactEvidence() {
      reads.push('evidence')
      return store.evidence
    },
    async readAudience({ channelId, userId }) {
      reads.push('audience')
      return (
        store.audience.get(`${channelId}:${userId}`) ?? {
          channelId: null,
          channelIsGroup: false,
          channelLive: false,
          participant: false,
          workspaceLive: false,
        }
      )
    },
    async readJobSource() {
      reads.push('job')
      const job = store.job
      store.afterJobRead?.()
      return job
    },
  })
  const authorize: JobOutboundAuthorize<typeof transaction> = async (scope, run) => {
    scopes.push({ scope, transaction })
    return run({ grantState, reads: readsFor(), transaction })
  }
  return { authorize, reads, scopes, transaction }
}

const plain = { artifact: null, destination, jobId: 'job-1', now: NOW }
const payload = { jobId: 'job-1', summary: 'Done.' }
const claim = { authority: { kind: 'workspace_grant' as const }, grant: artifactGrant }

describe('job outbound result service', () => {
  test('publishes under one scope with no grant lock when no artifact is claimed', async () => {
    const store = makeStore()
    const fake = fakeAuthorize(store, null)
    const service = createJobOutboundResultService(fake.authorize)
    expect(await service.publish({ ...plain, result: payload })).toMatchObject({
      action: 'publish',
      destination,
    })
    expect(fake.scopes).toEqual([{ scope: null, transaction: fake.transaction }])
  })

  test('opens the grant scope for an artifact and reads the grant state from it', async () => {
    const store = makeStore()
    const fake = fakeAuthorize(store, liveGrantState)
    const service = createJobOutboundResultService(fake.authorize)
    expect(
      await service.publish({ ...plain, artifact: claim, result: { ...payload, artifact: target } })
    ).toMatchObject({ action: 'publish', result: { artifact: target } })
    expect(fake.scopes[0]!.scope).toEqual({
      artifactId: 'artifact-1',
      grantId: 'artifact-grant-1',
      revision: 1,
      sourceWorkspaceId: SOURCE,
    })
  })

  test('releases a delivery to the release write inside the same scope, after the final reads', async () => {
    const store = makeStore()
    const fake = fakeAuthorize(store, null)
    const service = createJobOutboundResultService(fake.authorize)
    const released: Array<{ transaction: unknown; result: unknown }> = []
    const decision = await service.deliver(
      {
        artifact: null,
        destination,
        jobId: 'job-1',
        now: NOW,
        published: payload,
        recipientUserId: RECIPIENT,
      },
      async (context, result) => {
        released.push({ transaction: context.transaction, result })
      }
    )
    expect(decision).toMatchObject({ action: 'deliver', destination })
    expect(released).toEqual([
      {
        transaction: fake.transaction,
        result: { artifact: null, jobId: 'job-1', summary: 'Done.' },
      },
    ])
    expect(fake.scopes.length).toBe(1)
    expect(fake.reads).toEqual(['job', 'access', 'audience'])
  })

  test('recheck after awaits: a source revocation between reads denies, and nothing is released', async () => {
    const store = makeStore()
    store.afterJobRead = () => {
      store.access.set(`${SOURCE}:${ACTOR}`, { role: 'member', workspaceLive: true })
    }
    const fake = fakeAuthorize(store, null)
    const service = createJobOutboundResultService(fake.authorize)
    let released = 0
    expect(
      await service.deliver(
        {
          artifact: null,
          destination,
          jobId: 'job-1',
          now: NOW,
          published: payload,
          recipientUserId: RECIPIENT,
        },
        async () => {
          released += 1
        }
      )
    ).toEqual({ action: 'deny', gate: 'source', reason: 'source_access_lost' })
    expect(released).toBe(0)
  })

  test('a grant revoked before the scope reads it denies delivery and releases nothing', async () => {
    const store = makeStore()
    const fake = fakeAuthorize(store, { ...liveGrantState, revoked: true })
    const service = createJobOutboundResultService(fake.authorize)
    let released = 0
    expect(
      await service.deliver(
        {
          artifact: claim,
          destination,
          jobId: 'job-1',
          now: NOW,
          published: { ...payload, artifact: target },
          recipientUserId: RECIPIENT,
        },
        async () => {
          released += 1
        }
      )
    ).toEqual({ action: 'deny', gate: 'artifact', reason: 'grant_revoked' })
    expect(released).toBe(0)
  })

  test('cross-group substitution: a standing for another channel never releases to this destination', async () => {
    const store = makeStore()
    store.audience.set(`${CHANNEL}:${RECIPIENT}`, {
      channelId: 'channel-b',
      channelIsGroup: true,
      channelLive: true,
      participant: true,
      workspaceLive: true,
    })
    const fake = fakeAuthorize(store, null)
    const service = createJobOutboundResultService(fake.authorize)
    let released = 0
    expect(
      await service.deliver(
        {
          artifact: null,
          destination,
          jobId: 'job-1',
          now: NOW,
          published: payload,
          recipientUserId: RECIPIENT,
        },
        async () => {
          released += 1
        }
      )
    ).toEqual({ action: 'deny', gate: 'audience', reason: 'destination_channel_mismatch' })
    expect(released).toBe(0)
  })

  test('holds publication for a missing job without reading the actor’s access', async () => {
    const store = makeStore()
    store.job = null
    const fake = fakeAuthorize(store, null)
    const service = createJobOutboundResultService(fake.authorize)
    expect(await service.publish({ ...plain, result: payload })).toEqual({
      action: 'hold',
      gate: 'job',
      jobId: 'job-1',
      producerEffect: 'unaffected',
      reason: 'job_unavailable',
    })
    expect(fake.reads).toEqual(['job'])
  })

  test('propagates a failed read and releases nothing', async () => {
    const store = makeStore()
    const fake = fakeAuthorize(store, null)
    const failing: JobOutboundAuthorize<typeof fake.transaction> = (scope, run) =>
      fake.authorize(scope, (context) =>
        run({
          ...context,
          reads: {
            ...context.reads,
            async readAudience() {
              throw new Error('audience store unavailable')
            },
          },
        })
      )
    const service = createJobOutboundResultService(failing)
    let released = 0
    await expect(
      service.deliver(
        {
          artifact: null,
          destination,
          jobId: 'job-1',
          now: NOW,
          published: payload,
          recipientUserId: RECIPIENT,
        },
        async () => {
          released += 1
        }
      )
    ).rejects.toThrow('audience store unavailable')
    expect(released).toBe(0)
  })

  test('a release write that fails rejects the delivery, so the scope is not committed', async () => {
    const store = makeStore()
    const fake = fakeAuthorize(store, null)
    const service = createJobOutboundResultService(fake.authorize)
    await expect(
      service.deliver(
        {
          artifact: null,
          destination,
          jobId: 'job-1',
          now: NOW,
          published: payload,
          recipientUserId: RECIPIENT,
        },
        async () => {
          throw new Error('write failed')
        }
      )
    ).rejects.toThrow('write failed')
  })

  test('does not mutate the stored job', async () => {
    const store = makeStore()
    const before = JSON.stringify(store.job)
    const fake = fakeAuthorize(store, null)
    const service = createJobOutboundResultService(fake.authorize)
    await service.publish({ ...plain, result: payload })
    await service.deliver(
      {
        artifact: null,
        destination,
        jobId: 'job-1',
        now: NOW,
        published: payload,
        recipientUserId: RECIPIENT,
      },
      async () => {}
    )
    expect(JSON.stringify(store.job)).toBe(before)
  })
})
