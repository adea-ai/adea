import { describe, expect, test } from 'bun:test'

import {
  canonicalPortableJson,
  PORTABLE_WORKSPACE_EXPORT_EXCLUSIONS,
  PORTABLE_WORKSPACE_EXPORT_FORMAT,
  PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS,
  type PortableWorkspaceExport,
  type PortableWorkspaceExportIssue,
  validatePortableWorkspaceExport,
} from '../src/portable-export'

const at = '2026-10-01T10:00:00.000Z'
const later = '2026-10-01T10:05:00.000Z'
const digest = 'a'.repeat(64)
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

const ownerId = id(1)
const memberId = id(2)
const agentId = id(3)
const projectId = id(4)
const channelId = id(5)
const privateChannelId = id(6)
const taskId = id(7)
const messageId = id(8)
const replyId = id(9)
const deletedMessageId = id(10)
const contentRefId = id(11)

/** A closed, version-1 document covering every family. */
function fixture(): PortableWorkspaceExport {
  return {
    content: {
      agents: [
        {
          agentId,
          createdAt: at,
          isWorkspaceLead: false,
          lifecycleState: 'active',
          name: 'Researcher',
          profileId: 'profile.research',
          profileRevision: 0,
          profileState: 'available',
          profileVersion: '1.0.0',
          projectId,
          revision: 0,
          roleSummary: null,
          updatedAt: at,
        },
      ],
      channels: [
        {
          agentId: null,
          channelId,
          createdAt: at,
          isPrimaryProjectChannel: true,
          kind: 'project',
          lifecycleState: 'active',
          participants: [{ kind: 'user', userId: ownerId }],
          projectId,
          sortOrder: 0,
          taskId: null,
          title: 'Project lane',
          updatedAt: at,
          version: 1,
          visibility: 'workspace',
        },
        {
          agentId: null,
          channelId: privateChannelId,
          createdAt: at,
          isPrimaryProjectChannel: false,
          kind: 'group',
          lifecycleState: 'archived',
          participants: [
            { kind: 'user', userId: ownerId },
            { agentId, kind: 'agent' },
          ],
          projectId: null,
          sortOrder: 1,
          taskId: null,
          title: 'Private group',
          updatedAt: later,
          version: 2,
          visibility: 'participants',
        },
      ],
      contentRefs: [
        {
          bodyState: 'local_authority',
          contentRefId,
          contentType: 'message_body',
          createdAt: at,
          digestSha256: digest,
          keyVersion: 1,
          messageId: replyId,
          revision: 1,
          schemaVersion: 1,
          sensitivity: 'sensitive',
          storagePolicy: 'local_authority',
          synchronizationPolicy: 'local_only',
          taskId: null,
          updatedAt: at,
        },
      ],
      executionAttempts: [
        {
          attempt: 1,
          change: 'initial',
          createdAt: at,
          locationKind: 'agent_hq_cloud',
          taskId,
        },
      ],
      messages: [
        {
          body: { kind: 'text', text: 'Plan the export.' },
          channelId,
          createdAt: at,
          deletedAt: null,
          editedAt: null,
          mentions: [{ agentId, kind: 'agent' }],
          messageId,
          replyToMessageId: null,
          sender: { kind: 'user', userId: ownerId },
          taskId,
          threadRootMessageId: null,
          updatedAt: at,
          version: 1,
        },
        {
          body: { kind: 'content_ref', contentRefId },
          channelId,
          createdAt: later,
          deletedAt: null,
          editedAt: null,
          mentions: [],
          messageId: replyId,
          replyToMessageId: messageId,
          sender: { agentId, kind: 'agent' },
          taskId: null,
          threadRootMessageId: messageId,
          updatedAt: later,
          version: 1,
        },
        {
          body: { kind: 'deleted' },
          channelId,
          createdAt: later,
          deletedAt: later,
          editedAt: null,
          mentions: [],
          messageId: deletedMessageId,
          replyToMessageId: null,
          sender: { kind: 'system', systemId: 'runtime-result' },
          taskId: null,
          threadRootMessageId: null,
          updatedAt: later,
          version: 2,
        },
      ],
      projects: [
        {
          createdAt: at,
          iconKey: 'folder',
          lifecycleState: 'active',
          members: [{ role: 'editor', userId: memberId }],
          name: 'Adea',
          projectId,
          sortOrder: 0,
          sourceKind: 'repository',
          updatedAt: at,
          visibility: 'members',
        },
      ],
      tasks: [
        {
          agentId,
          channelId,
          createdAt: at,
          creatorUserId: ownerId,
          kind: 'feature',
          lifecycleState: 'in_progress',
          messageId,
          objective: 'Export the workspace.',
          objectiveContentRefId: null,
          priority: 'normal',
          projectId,
          taskId,
          threadRootMessageId: messageId,
          title: 'Portable export',
          updatedAt: at,
          version: 3,
        },
      ],
      taskDependencies: [],
      users: [
        { displayName: 'Owner', userId: ownerId },
        { displayName: null, userId: memberId },
      ],
      workspace: {
        accent: 'violet',
        createdAt: at,
        logoKind: 'box',
        logoValue: null,
        name: 'Workspace',
        scene: 'work',
        updatedAt: at,
        version: 4,
        workspaceId: id(12),
      },
    },
    contentDigest: { algorithm: 'sha256', value: digest },
    exclusions: PORTABLE_WORKSPACE_EXPORT_EXCLUSIONS,
    exportedAt: later,
    exportedBy: { role: 'owner', userId: ownerId },
    format: PORTABLE_WORKSPACE_EXPORT_FORMAT,
    formatVersion: 1,
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function issuesOf(value: unknown): readonly PortableWorkspaceExportIssue[] {
  const result = validatePortableWorkspaceExport(value)
  if (result.ok) throw new Error('expected the document to be rejected')
  return result.issues
}

describe('portable workspace export contract', () => {
  test('accepts a closed version-1 document covering every family', () => {
    const result = validatePortableWorkspaceExport(fixture())
    expect(result.ok).toBe(true)
  })

  test('rejects values that are not documents without throwing', () => {
    for (const value of [null, undefined, 42, 'export', [], { format: 'other' }]) {
      expect(validatePortableWorkspaceExport(value).ok).toBe(false)
    }
  })

  test('rejects an unknown format or format version', () => {
    const wrongFormat = { ...fixture(), format: 'adea.other' }
    const wrongVersion = { ...fixture(), formatVersion: 2 }
    expect(issuesOf(wrongFormat).map((issue) => issue.path)).toContain('document.format')
    expect(issuesOf(wrongVersion).map((issue) => issue.path)).toContain('document.formatVersion')
  })

  test('rejects any unknown field at every level, so new columns cannot leak by default', () => {
    const topLevel = { ...clone(fixture()), privateNotes: 'x' }
    const nested = clone(fixture())
    ;(nested.content.messages[0] as Record<string, unknown>).nativeSessionRef = 'native'
    const credential = clone(fixture())
    ;(credential.content.users[0] as Record<string, unknown>).email = 'owner@example.test'
    const withheldBody = clone(fixture())
    ;(withheldBody.content.contentRefs[0] as Record<string, unknown>).ciphertext = 'opaque'

    expect(issuesOf(topLevel)).toContainEqual(
      expect.objectContaining({ code: 'unknown_field', path: 'document.privateNotes' })
    )
    expect(issuesOf(nested)).toContainEqual(
      expect.objectContaining({
        code: 'unknown_field',
        path: 'document.content.messages[0].nativeSessionRef',
      })
    )
    expect(issuesOf(credential)).toContainEqual(
      expect.objectContaining({ code: 'unknown_field', path: 'document.content.users[0].email' })
    )
    expect(issuesOf(withheldBody)).toContainEqual(
      expect.objectContaining({
        code: 'unknown_field',
        path: 'document.content.contentRefs[0].ciphertext',
      })
    )
  })

  test('refuses a content ref that claims a body, availability or any storage other than local authority', () => {
    const availability = clone(fixture())
    ;(availability.content.contentRefs[0] as Record<string, unknown>).availability = 'available'
    const cloudStorage = clone(fixture())
    ;(cloudStorage.content.contentRefs[0] as { storagePolicy: string }).storagePolicy = 'cloud'

    expect(issuesOf(availability).map((issue) => issue.code)).toContain('unknown_field')
    expect(issuesOf(cloudStorage).map((issue) => issue.code)).toContain('value')
  })

  test('requires the version-1 exclusion ledger verbatim', () => {
    const trimmed = clone(fixture())
    trimmed.exclusions = trimmed.exclusions.filter((entry) => entry.class !== 'credentials')
    expect(issuesOf(trimmed)).toContainEqual(
      expect.objectContaining({ code: 'exclusions', path: 'document.exclusions' })
    )
  })

  test('rejects non-canonical identifiers, timestamps and digests', () => {
    const upperId = clone(fixture())
    upperId.content.users[0]!.userId = 'ABCDEF01-0000-4000-8000-000000000001'
    const looseTime = clone(fixture())
    ;(looseTime.content.tasks[0] as { createdAt: string }).createdAt = '2026-10-01T10:00:00Z'
    const shortDigest = clone(fixture())
    ;(shortDigest as { contentDigest: { value: string } }).contentDigest.value = 'abc'

    expect(issuesOf(upperId)).toContainEqual(
      expect.objectContaining({ code: 'value', path: 'document.content.users[0].userId' })
    )
    expect(issuesOf(looseTime)).toContainEqual(
      expect.objectContaining({ code: 'value', path: 'document.content.tasks[0].createdAt' })
    )
    expect(issuesOf(shortDigest)).toContainEqual(
      expect.objectContaining({ code: 'value', path: 'document.contentDigest.value' })
    )
  })

  test('never echoes a bundle value in an issue', () => {
    const canary = 'CANARY-SECRET-7f3a9c'
    const hostile = clone(fixture())
    ;(hostile.content.users[0] as { userId: string }).userId = canary
    const serialized = JSON.stringify(issuesOf(hostile))
    expect(serialized).not.toContain(canary)
  })

  test('fails closed on a message that names a channel, user or agent outside the document', () => {
    const danglingChannel = clone(fixture())
    danglingChannel.content.messages[0]!.channelId = id(90)
    const danglingAuthor = clone(fixture())
    danglingAuthor.content.messages[0]!.sender = { kind: 'user', userId: id(91) }
    const danglingMention = clone(fixture())
    danglingMention.content.messages[0]!.mentions = [{ agentId: id(92), kind: 'agent' }]

    for (const bundle of [danglingChannel, danglingAuthor, danglingMention]) {
      expect(issuesOf(bundle).some((issue) => issue.code === 'closure')).toBe(true)
    }
  })

  test('refuses thread and reply links across channels', () => {
    const crossChannel = clone(fixture())
    crossChannel.content.messages[1]!.channelId = privateChannelId
    expect(issuesOf(crossChannel).some((issue) => issue.code === 'invariant')).toBe(true)
  })

  test('keeps deletion and body in agreement', () => {
    const deletedWithBody = clone(fixture())
    deletedWithBody.content.messages[0]!.deletedAt = later
    const bodyOnDeleted = clone(fixture())
    bodyOnDeleted.content.messages[2]!.deletedAt = null
    expect(issuesOf(deletedWithBody).some((issue) => issue.code === 'invariant')).toBe(true)
    expect(issuesOf(bodyOnDeleted).some((issue) => issue.code === 'invariant')).toBe(true)
  })

  test('requires exactly one task objective source and a standalone workspace lead', () => {
    const bothObjectives = clone(fixture())
    bothObjectives.content.tasks[0]!.objectiveContentRefId = contentRefId
    const leadInProject = clone(fixture())
    leadInProject.content.agents[0]!.isWorkspaceLead = true
    expect(issuesOf(bothObjectives).some((issue) => issue.code === 'invariant')).toBe(true)
    expect(issuesOf(leadInProject).some((issue) => issue.code === 'invariant')).toBe(true)
  })

  test('rejects duplicated records and self-dependent tasks', () => {
    const duplicateUser = clone(fixture())
    duplicateUser.content.users.push({ displayName: 'Again', userId: ownerId })
    const selfDependency = clone(fixture())
    selfDependency.content.taskDependencies = [{ dependsOnTaskId: taskId, taskId }]
    expect(issuesOf(duplicateUser).some((issue) => issue.code === 'duplicate')).toBe(true)
    expect(issuesOf(selfDependency).some((issue) => issue.code === 'invariant')).toBe(true)
  })

  test('bounds every family so an oversized bundle is refused rather than parsed', () => {
    const oversized = clone(fixture())
    oversized.content.users = Array.from(
      { length: PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1 },
      (_, index) => ({
        displayName: null,
        userId: id(index + 1000),
      })
    )
    expect(issuesOf(oversized).some((issue) => issue.code === 'limit')).toBe(true)
  })
})

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys)
  if (typeof value !== 'object' || value === null) return value
  const reversed: Record<string, unknown> = {}
  for (const key of Object.keys(value).toReversed())
    reversed[key] = reverseKeys((value as Record<string, unknown>)[key])
  return reversed
}

describe('canonical portable JSON', () => {
  test('sorts object keys at every depth and preserves array order', () => {
    expect(canonicalPortableJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[{"y":2,"z":1}]},"b":1}'
    )
  })

  test('is independent of the order a document was serialized in', () => {
    const original = fixture()
    expect(JSON.stringify(reverseKeys(original))).not.toBe(JSON.stringify(original))
    expect(canonicalPortableJson(reverseKeys(original))).toBe(canonicalPortableJson(original))
  })
})
