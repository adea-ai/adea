import { describe, expect, test } from 'bun:test'

import {
  createJobOutboundResultService,
  type JobOutboundPorts,
} from '../../src/job-outbound-result-service'
import type {
  ArtifactReferenceEvidence,
  ArtifactReferenceGrant,
  ArtifactReferenceGrantState,
  ArtifactReferenceTarget,
  GroupAdmission,
  GroupCompletedJob,
} from '@adea-ai/types'

/**
 * Service suites for M15 #1217. The store is an in-memory fake whose state a
 * test mutates between calls; every port counts its reads so the suites prove
 * that delivery re-reads current authority instead of reusing publication's.
 */

const CHECKSUM = 'a'.repeat(64)
const GROUP = 'group-1'
const SOURCE = 'ws-source'
const AUDIENCE = 'ws-audience'
const OWNER = { kind: 'user', userId: 'user-owner' } as const
const RECIPIENT = { kind: 'user', userId: 'user-recipient' } as const
const NOW = '2026-10-08T12:00:00.000Z'

const target: ArtifactReferenceTarget = {
  artifactId: 'artifact-1',
  audienceWorkspaceId: AUDIENCE,
  checksumSha256: CHECKSUM,
  sourceWorkspaceId: SOURCE,
  version: 3,
}

function makeStore() {
  const reads = { admission: 0, evidence: 0, grantState: 0, job: 0 }
  const evidenceCalls: Array<{ artifactId: string; workspaceId: string }> = []
  const grantStateCalls: Array<{ grantId: string; revision: number }> = []
  const store = {
    admissions: new Map<string, GroupAdmission>(),
    evidence: new Map<string, ArtifactReferenceEvidence>(),
    grantStates: new Map<string, ArtifactReferenceGrantState>(),
    jobs: new Map<string, GroupCompletedJob>(),
    reads,
    evidenceCalls,
    grantStateCalls,
  }
  const ports: JobOutboundPorts = {
    async readArtifactEvidence(input) {
      reads.evidence += 1
      evidenceCalls.push(input)
      return store.evidence.get(input.artifactId) ?? null
    },
    async readArtifactGrantState({ grantId, revision }) {
      grantStateCalls.push({ grantId, revision })
      reads.grantState += 1
      return store.grantStates.get(grantId) ?? null
    },
    async readCompletedJob(jobId) {
      reads.job += 1
      return store.jobs.get(jobId) ?? null
    },
    async readGroupAdmission({ groupId, participant }) {
      reads.admission += 1
      return store.admissions.get(key(participant, groupId)) ?? null
    },
  }
  return { ...store, ports }
}

function key(participant: { kind: string }, groupId = GROUP) {
  return `${groupId}:${participant.kind}:${JSON.stringify(participant)}`
}

function admission(participant: GroupAdmission['participant'], grantId: string): GroupAdmission {
  return {
    authorization: { groupId: GROUP, grantId, revision: 1 },
    grant: { expiresAt: null, issuedAt: '2026-10-01T00:00:00.000Z', revokedAt: null },
    joinPoint: { joinedAt: '2026-10-01T00:00:00.000Z', joinedSequence: 0 },
    participant,
  }
}

function job(): GroupCompletedJob {
  return {
    authorization: { groupId: GROUP, grantId: 'grant-owner', revision: 1 },
    completedAt: '2026-10-08T11:00:00.000Z',
    jobId: 'job-1',
    participant: OWNER,
  }
}

const artifactGrant: ArtifactReferenceGrant = {
  artifactId: 'artifact-1',
  audienceWorkspaceId: AUDIENCE,
  checksumSha256: CHECKSUM,
  expiresAt: null,
  grantId: 'artifact-grant-1',
  revokedAt: null,
  revision: 1,
  sourceWorkspaceId: SOURCE,
  version: 3,
}

function seed() {
  const store = makeStore()
  store.jobs.set('job-1', job())
  store.admissions.set(key(OWNER), admission(OWNER, 'grant-owner'))
  store.admissions.set(key(RECIPIENT), admission(RECIPIENT, 'grant-recipient'))
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
    audienceWorkspaceIds: [AUDIENCE],
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

const recipient = { groupId: GROUP, participant: RECIPIENT, workspaceId: AUDIENCE }

describe('job outbound result service', () => {
  test('publishes a plain result, then delivers it after re-reading the recipient', async () => {
    const store = seed()
    const service = createJobOutboundResultService(store.ports)
    const published = await service.publish({
      artifact: null,
      groupId: GROUP,
      jobId: 'job-1',
      now: NOW,
      publisher: OWNER,
      result: { jobId: 'job-1', summary: 'Done.' },
    })
    expect(published).toMatchObject({ action: 'publish', jobId: 'job-1' })
    if (published.action !== 'publish') throw new Error('expected publish')

    const before = store.reads.admission
    const delivered = await service.deliver({
      artifact: null,
      now: NOW,
      published: published.result,
      recipient,
    })
    expect(delivered).toEqual({
      action: 'deliver',
      result: { artifact: null, jobId: 'job-1', summary: 'Done.' },
    })
    expect(store.reads.admission).toBe(before + 1)
  })

  test('denies the next delivery after the recipient is revoked, with no cached allowance', async () => {
    const store = seed()
    const service = createJobOutboundResultService(store.ports)
    const payload = { artifact: null, jobId: 'job-1', summary: 'Done.' }
    expect(
      (await service.deliver({ artifact: null, now: NOW, published: payload, recipient })).action
    ).toBe('deliver')
    store.admissions.set(key(RECIPIENT), {
      ...admission(RECIPIENT, 'grant-recipient'),
      grant: {
        expiresAt: null,
        issuedAt: '2026-10-01T00:00:00.000Z',
        revokedAt: '2026-10-08T11:30:00.000Z',
      },
    })
    expect(
      await service.deliver({ artifact: null, now: NOW, published: payload, recipient })
    ).toEqual({ action: 'deny', gate: 'audience', reason: 'recipient_participation_revoked' })
  })

  test('denies an artifact delivery whose grant was revoked after publication', async () => {
    const store = seed()
    const service = createJobOutboundResultService(store.ports)
    const claim = { authority: { kind: 'workspace_grant' as const }, grant: artifactGrant }
    const published = await service.publish({
      artifact: claim,
      groupId: GROUP,
      jobId: 'job-1',
      now: NOW,
      publisher: OWNER,
      result: { artifact: target, jobId: 'job-1', summary: 'Report attached.' },
    })
    expect(published.action).toBe('publish')
    if (published.action !== 'publish') throw new Error('expected publish')

    const delivered = await service.deliver({
      artifact: claim,
      now: NOW,
      published: published.result,
      recipient,
    })
    expect(delivered).toMatchObject({ action: 'deliver', result: { artifact: target } })

    store.grantStates.set('artifact-grant-1', {
      ...store.grantStates.get('artifact-grant-1')!,
      revoked: true,
    })
    expect(
      await service.deliver({ artifact: claim, now: NOW, published: published.result, recipient })
    ).toEqual({ action: 'deny', gate: 'artifact', reason: 'grant_revoked' })
  })

  test('reads artifact evidence from the source workspace and the registered grant', async () => {
    const store = seed()
    const service = createJobOutboundResultService(store.ports)
    await service.publish({
      artifact: { authority: { kind: 'workspace_grant' }, grant: artifactGrant },
      groupId: GROUP,
      jobId: 'job-1',
      now: NOW,
      publisher: OWNER,
      result: { artifact: target, jobId: 'job-1', summary: 'Report attached.' },
    })
    expect(store.evidenceCalls).toEqual([{ artifactId: 'artifact-1', workspaceId: SOURCE }])
    expect(store.grantStateCalls).toEqual([{ grantId: 'artifact-grant-1', revision: 1 }])
  })

  test('holds a job that is missing or whose identity does not match the request', async () => {
    const store = seed()
    const service = createJobOutboundResultService(store.ports)
    const input = {
      artifact: null,
      groupId: GROUP,
      now: NOW,
      publisher: OWNER,
      result: { jobId: 'job-1', summary: 'Done.' },
    }
    expect(await service.publish({ ...input, jobId: 'job-missing' })).toEqual({
      action: 'hold',
      gate: 'job',
      jobId: 'job-missing',
      producerEffect: 'unaffected',
      reason: 'job_unavailable',
    })
    store.jobs.set('job-2', { ...job(), jobId: 'job-other' })
    expect(await service.publish({ ...input, jobId: 'job-2' })).toMatchObject({
      gate: 'job',
      reason: 'job_unavailable',
    })
  })

  test('holds a publisher who is not the owner and leaves the stored job unchanged', async () => {
    const store = seed()
    const service = createJobOutboundResultService(store.ports)
    const stored = JSON.stringify(store.jobs.get('job-1'))
    const decision = await service.publish({
      artifact: null,
      groupId: GROUP,
      jobId: 'job-1',
      now: NOW,
      publisher: RECIPIENT,
      result: { jobId: 'job-1', summary: 'Done.' },
    })
    expect(decision).toMatchObject({
      action: 'hold',
      gate: 'group',
      reason: 'publication_authority_mismatch',
    })
    expect(JSON.stringify(store.jobs.get('job-1'))).toBe(stored)
  })

  test('propagates a failed read instead of deciding on partial authority', async () => {
    const store = seed()
    const failing = createJobOutboundResultService({
      ...store.ports,
      readArtifactGrantState: async () => {
        throw new Error('grant store unavailable')
      },
    })
    const claim = { authority: { kind: 'workspace_grant' as const }, grant: artifactGrant }
    await expect(
      failing.deliver({
        artifact: claim,
        now: NOW,
        published: { artifact: target, jobId: 'job-1', summary: 'Report attached.' },
        recipient,
      })
    ).rejects.toThrow('grant store unavailable')
  })
})
