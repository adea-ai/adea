import { describe, expect, test } from 'bun:test'

import {
  createJobOutboundResultService,
  type JobOutboundPorts,
} from '../../src/job-outbound-result-service'
import type { JobOutboundAccess, JobOutboundJobSource } from '../../src/job-outbound-result-policy'
import type {
  ArtifactReferenceEvidence,
  ArtifactReferenceGrant,
  ArtifactReferenceGrantState,
  ArtifactReferenceTarget,
} from '@adea-ai/types'

/**
 * Service suites for M15 #1217. The store is an in-memory fake whose state a
 * test mutates between calls. Every port counts its reads, so the suites prove
 * that publish and delivery re-read current authority rather than reusing an
 * earlier snapshot.
 */

const CHECKSUM = 'a'.repeat(64)
const SOURCE = 'ws-source'
const DEST = 'ws-dest'
const ACTOR = 'user-actor'
const RECIPIENT = 'user-recipient'
const NOW = '2026-10-08T12:00:00.000Z'

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

function makeStore() {
  const calls = {
    access: [] as Array<{ userId: string; workspaceId: string }>,
    evidence: [] as Array<{ artifactId: string; principalUserId: string; workspaceId: string }>,
    grantState: [] as Array<{ grantId: string; revision: number }>,
    job: [] as string[],
  }
  const store = {
    access: new Map<string, JobOutboundAccess>(),
    evidence: new Map<string, ArtifactReferenceEvidence>(),
    grantStates: new Map<string, ArtifactReferenceGrantState>(),
    jobs: new Map<string, JobOutboundJobSource>(),
    calls,
    failGrantRead: false,
  }
  const ports: JobOutboundPorts = {
    async readAccess({ userId, workspaceId }) {
      calls.access.push({ userId, workspaceId })
      return store.access.get(`${workspaceId}:${userId}`) ?? { role: null, workspaceLive: false }
    },
    async readArtifactEvidence(input) {
      calls.evidence.push(input)
      return store.evidence.get(input.artifactId) ?? null
    },
    async readArtifactGrantState(presentation) {
      calls.grantState.push(presentation)
      if (store.failGrantRead) throw new Error('grant store unavailable')
      return store.grantStates.get(presentation.grantId) ?? null
    },
    async readJobSource(jobId) {
      calls.job.push(jobId)
      return store.jobs.get(jobId) ?? null
    },
  }
  // Assign onto the same object the ports close over, so flags set by a test are seen.
  return Object.assign(store, { ports })
}

function seed() {
  const store = makeStore()
  store.jobs.set('job-1', {
    completedAt: '2026-10-08T11:00:00.000Z',
    jobId: 'job-1',
    originalActorUserId: ACTOR,
    sourceWorkspaceId: SOURCE,
  })
  store.access.set(`${SOURCE}:${ACTOR}`, { role: 'owner', workspaceLive: true })
  store.access.set(`${DEST}:${RECIPIENT}`, { role: 'member', workspaceLive: true })
  store.evidence.set('artifact-1', {
    availability: 'available',
    checksumSha256: CHECKSUM,
    deletionState: 'active',
    id: 'artifact-1',
    sensitivity: 'workspace',
    version: 3,
    workspaceId: SOURCE,
  })
  store.grantStates.set('artifact-grant-1', {
    artifactId: 'artifact-1',
    audienceWorkspaceIds: [DEST],
    checksumSha256: CHECKSUM,
    expiresAt: null,
    grantId: 'artifact-grant-1',
    revoked: false,
    revision: 1,
    sourceWorkspaceId: SOURCE,
    version: 3,
  })
  return store
}

const plain = { artifact: null, destinationWorkspaceId: DEST, jobId: 'job-1', now: NOW }
const payload = { jobId: 'job-1', summary: 'Done.' }

describe('job outbound result service', () => {
  test('publishes for the source owner, then delivers after re-reading source and recipient access', async () => {
    const store = seed()
    const service = createJobOutboundResultService(store.ports)
    const published = await service.publish({ ...plain, result: payload })
    expect(published).toMatchObject({ action: 'publish', destinationWorkspaceId: DEST })
    if (published.action !== 'publish') throw new Error('expected publish')

    const reads = store.calls.access.length
    const delivered = await service.deliver({
      artifact: null,
      destinationWorkspaceId: DEST,
      jobId: 'job-1',
      now: NOW,
      published: published.result,
      recipientUserId: RECIPIENT,
    })
    expect(delivered).toMatchObject({ action: 'deliver', destinationWorkspaceId: DEST })
    // Delivery reads the original actor's source access and the recipient's destination access.
    expect(store.calls.access.length).toBe(reads + 2)
    expect(store.calls.access.slice(-2)).toEqual([
      { userId: ACTOR, workspaceId: SOURCE },
      { userId: RECIPIENT, workspaceId: DEST },
    ])
  })

  test('denies the next delivery once the original actor is demoted, with no cached allowance', async () => {
    const store = seed()
    const service = createJobOutboundResultService(store.ports)
    const deliver = () =>
      service.deliver({
        artifact: null,
        destinationWorkspaceId: DEST,
        jobId: 'job-1',
        now: NOW,
        published: payload,
        recipientUserId: RECIPIENT,
      })
    expect((await deliver()).action).toBe('deliver')

    store.access.set(`${SOURCE}:${ACTOR}`, { role: 'member', workspaceLive: true })
    expect(await deliver()).toEqual({
      action: 'deny',
      gate: 'source',
      reason: 'source_access_lost',
    })
  })

  test('denies release to a recipient removed from the destination after publication', async () => {
    const store = seed()
    const service = createJobOutboundResultService(store.ports)
    store.access.set(`${DEST}:${RECIPIENT}`, { role: null, workspaceLive: true })
    expect(
      await service.deliver({
        artifact: null,
        destinationWorkspaceId: DEST,
        jobId: 'job-1',
        now: NOW,
        published: payload,
        recipientUserId: RECIPIENT,
      })
    ).toEqual({ action: 'deny', gate: 'audience', reason: 'recipient_not_destination_member' })
  })

  test('reads artifact evidence as the original actor in the source workspace and the grant at its revision', async () => {
    const store = seed()
    const service = createJobOutboundResultService(store.ports)
    const published = await service.publish({
      ...plain,
      artifact: { authority: { kind: 'workspace_grant' }, grant: artifactGrant },
      result: { ...payload, artifact: target },
    })
    expect(published.action).toBe('publish')
    expect(store.calls.evidence).toEqual([
      { artifactId: 'artifact-1', principalUserId: ACTOR, workspaceId: SOURCE },
    ])
    expect(store.calls.grantState).toEqual([{ grantId: 'artifact-grant-1', revision: 1 }])
  })

  test('denies an artifact delivery whose grant was revoked after publication', async () => {
    const store = seed()
    const service = createJobOutboundResultService(store.ports)
    const claim = { authority: { kind: 'workspace_grant' as const }, grant: artifactGrant }
    const published = await service.publish({
      ...plain,
      artifact: claim,
      result: { ...payload, artifact: target },
    })
    if (published.action !== 'publish') throw new Error('expected publish')

    const deliver = () =>
      service.deliver({
        artifact: claim,
        destinationWorkspaceId: DEST,
        jobId: 'job-1',
        now: NOW,
        published: published.result,
        recipientUserId: RECIPIENT,
      })
    expect(await deliver()).toMatchObject({ action: 'deliver', result: { artifact: target } })

    store.grantStates.set('artifact-grant-1', {
      ...store.grantStates.get('artifact-grant-1')!,
      revoked: true,
    })
    expect(await deliver()).toEqual({ action: 'deny', gate: 'artifact', reason: 'grant_revoked' })
  })

  test('holds publication for a missing job without reading the actor’s access', async () => {
    const store = seed()
    const service = createJobOutboundResultService(store.ports)
    expect(
      await service.publish({
        ...plain,
        jobId: 'job-missing',
        result: { ...payload, jobId: 'job-missing' },
      })
    ).toEqual({
      action: 'hold',
      gate: 'job',
      jobId: 'job-missing',
      producerEffect: 'unaffected',
      reason: 'job_unavailable',
    })
    expect(store.calls.access).toEqual([])
  })

  test('holds publication when the job record names another job', async () => {
    const store = seed()
    store.jobs.set('job-2', { ...store.jobs.get('job-1')!, jobId: 'job-other' })
    const service = createJobOutboundResultService(store.ports)
    expect(
      await service.publish({ ...plain, jobId: 'job-2', result: { ...payload, jobId: 'job-2' } })
    ).toMatchObject({ gate: 'job', reason: 'job_unavailable' })
  })

  test('holds publication from a source workspace where the actor is no longer an owner', async () => {
    const store = seed()
    store.access.set(`${SOURCE}:${ACTOR}`, { role: 'member', workspaceLive: true })
    const service = createJobOutboundResultService(store.ports)
    expect(await service.publish({ ...plain, result: payload })).toMatchObject({
      gate: 'source',
      reason: 'source_access_lost',
    })
  })

  test('leaves the stored job unchanged by publish and delivery', async () => {
    const store = seed()
    const before = JSON.stringify(store.jobs.get('job-1'))
    const service = createJobOutboundResultService(store.ports)
    await service.publish({ ...plain, result: payload })
    await service.deliver({
      artifact: null,
      destinationWorkspaceId: DEST,
      jobId: 'job-1',
      now: NOW,
      published: payload,
      recipientUserId: RECIPIENT,
    })
    expect(JSON.stringify(store.jobs.get('job-1'))).toBe(before)
  })

  test('propagates a failed read instead of deciding on partial authority', async () => {
    const store = seed()
    store.failGrantRead = true
    const service = createJobOutboundResultService(store.ports)
    await expect(
      service.deliver({
        artifact: { authority: { kind: 'workspace_grant' }, grant: artifactGrant },
        destinationWorkspaceId: DEST,
        jobId: 'job-1',
        now: NOW,
        published: { ...payload, artifact: target },
        recipientUserId: RECIPIENT,
      })
    ).rejects.toThrow('grant store unavailable')
  })
})
