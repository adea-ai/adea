import { describe, expect, test } from 'bun:test'

import {
  PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS,
  validatePortableWorkspaceExport,
} from '@adea-ai/types'

import {
  bounded,
  buildPortableWorkspaceExport,
  byKey,
  groupBy,
  mapPortableContent,
  PORTABLE_SYSTEM_SENDER_ID,
  PortableExportError,
  portableContentDigest,
  type ReadInputs,
} from '../../src/portable-export-content'

const ids = {
  agent: '00000000-0000-4000-8000-00000000a001',
  channel: '00000000-0000-4000-8000-00000000c001',
  channelHidden: '00000000-0000-4000-8000-00000000c002',
  contentRef: '00000000-0000-4000-8000-00000000d001',
  contentRefHidden: '00000000-0000-4000-8000-00000000d002',
  message: '00000000-0000-4000-8000-00000000e001',
  messageReply: '00000000-0000-4000-8000-00000000e002',
  messageDeleted: '00000000-0000-4000-8000-00000000e003',
  messageHiddenRef: '00000000-0000-4000-8000-00000000e004',
  messageOtherChannel: '00000000-0000-4000-8000-00000000e005',
  project: '00000000-0000-4000-8000-00000000f001',
  projectHidden: '00000000-0000-4000-8000-00000000f002',
  task: '00000000-0000-4000-8000-00000000b001',
  taskHidden: '00000000-0000-4000-8000-00000000b002',
  user: '00000000-0000-4000-8000-000000001001',
  taskMissing: '00000000-0000-4000-8000-00000000b003',
  workspace: '00000000-0000-4000-8000-0000000000aa',
}
const at = new Date('2026-10-01T10:00:00.000Z')
const iso = '2026-10-01T10:00:00.000Z'
const binding = 'job-outbound:v1:ENCODED-PRIVATE-BINDING-7f3a'

/** Plain fixtures for the reader's output. The mapper reads only the fields listed here. */
function inputs(overrides: Partial<ReadInputs> = {}): ReadInputs {
  const message = (fields: Record<string, unknown>) => ({
    artifactIds: [],
    channelId: ids.channel,
    createdAt: iso,
    deleted: false,
    id: ids.message,
    mentions: [],
    sender: { kind: 'user', userId: ids.user },
    sequence: 1,
    updatedAt: iso,
    version: 1,
    workspaceId: ids.workspace,
    ...fields,
  })
  const base = {
    agentRows: [],
    attemptRows: [],
    channels: [
      {
        createdAt: iso,
        id: ids.channel,
        isPrimaryProjectChannel: false,
        kind: 'group',
        lifecycleState: 'active',
        participants: [{ kind: 'user', userId: ids.user }],
        sortOrder: 0,
        title: 'Lane',
        updatedAt: iso,
        version: 1,
        visibility: 'workspace',
        workspaceId: ids.workspace,
      },
    ],
    contentRefRows: [],
    dependencyRows: [],
    memberRows: [],
    messages: [
      message({ bodyText: 'Plain text', id: ids.message, sequence: 1 }),
      message({
        bodyText: undefined,
        deleted: true,
        deletedAt: iso,
        id: ids.messageDeleted,
        sequence: 2,
      }),
      message({
        id: ids.messageReply,
        replyToMessageId: ids.message,
        sender: { kind: 'system', systemId: binding },
        sequence: 3,
        threadRootMessageId: ids.message,
        bodyText: 'Publication body',
      }),
      message({
        bodyContentRefId: ids.contentRefHidden,
        bodyText: undefined,
        id: ids.messageHiddenRef,
        sequence: 4,
      }),
      message({
        channelId: ids.channelHidden,
        id: ids.messageOtherChannel,
        sequence: 5,
        threadRootMessageId: ids.message,
        bodyText: 'Cross-channel reply',
      }),
    ],
    projectRows: [
      {
        createdAt: at,
        iconKey: 'folder',
        id: ids.project,
        lifecycleState: 'active',
        name: 'Lane project',
        sortOrder: 0,
        sourceKind: 'none',
        updatedAt: at,
        visibility: 'members',
      },
    ],
    taskRows: [
      {
        agentId: ids.agent,
        channelId: ids.channel,
        createdAt: at,
        creatorUserId: ids.user,
        id: ids.task,
        kind: 'feature',
        lifecycleState: 'queued',
        messageId: ids.message,
        objective: 'Plan the lane.',
        objectiveContentRefId: null,
        priority: 'normal',
        projectId: ids.project,
        threadRootMessageId: null,
        title: 'Lane task',
        updatedAt: at,
        version: 1,
      },
      {
        agentId: null,
        channelId: ids.channelHidden,
        createdAt: at,
        creatorUserId: ids.user,
        id: ids.taskHidden,
        kind: 'bug',
        lifecycleState: 'created',
        messageId: ids.messageOtherChannel,
        objective: 'Outside the audience.',
        objectiveContentRefId: null,
        priority: 'low',
        projectId: ids.project,
        threadRootMessageId: null,
        title: 'Outside task',
        updatedAt: at,
        version: 1,
      },
    ],
    userRows: [{ displayName: 'Lane user', id: ids.user }],
    visibleContentRefIds: new Set<string>(),
    workspace: {
      accent: null,
      createdAt: at,
      id: ids.workspace,
      logoKind: 'box',
      logoValue: null,
      name: 'Lane workspace',
      scene: 'home',
      updatedAt: at,
      version: 1,
    },
    ...overrides,
  }
  return base as unknown as ReadInputs
}

describe('portable export mapping', () => {
  test('a system sender leaves as the opaque label, never as the stored identifier', () => {
    const content = mapPortableContent(inputs())
    const serialized = JSON.stringify(content)
    expect(serialized).not.toContain(binding)
    expect(serialized).not.toContain('ENCODED-PRIVATE-BINDING')
    const reply = content.messages.find((message) => message.messageId === ids.messageReply)
    expect(reply?.sender).toEqual({ kind: 'system', systemId: PORTABLE_SYSTEM_SENDER_ID })
  })

  test('a deleted message becomes a tombstone with no body, and a withheld body takes its message and links with it', () => {
    const content = mapPortableContent(inputs())
    const deleted = content.messages.find((message) => message.messageId === ids.messageDeleted)
    expect(deleted?.body).toEqual({ kind: 'deleted' })
    expect(deleted?.deletedAt).toBe(iso)
    expect(content.messages.map((message) => message.messageId)).not.toContain(ids.messageHiddenRef)
  })

  test('a same-channel thread or reply link is kept, and a message in a channel that is not exported is withheld', () => {
    const content = mapPortableContent(inputs())
    const reply = content.messages.find((message) => message.messageId === ids.messageReply)
    expect(reply?.threadRootMessageId).toBe(ids.message)
    expect(reply?.replyToMessageId).toBe(ids.message)
    expect(content.messages.map((message) => message.messageId)).not.toContain(
      ids.messageOtherChannel
    )
  })

  test('conversation order follows the source sequence, not the identifier, whatever order the input lists', () => {
    // The root has the greater identifier and the lower sequence, so an order by identifier inverts the thread.
    const base = {
      artifactIds: [],
      channelId: ids.channel,
      createdAt: iso,
      deleted: false,
      mentions: [],
      sender: { kind: 'user', userId: ids.user },
      updatedAt: iso,
      version: 1,
      workspaceId: ids.workspace,
    }
    const root = { ...base, bodyText: 'Root', id: ids.messageReply, sequence: 1 }
    const reply = {
      ...base,
      bodyText: 'Reply',
      id: ids.message,
      replyToMessageId: ids.messageReply,
      sequence: 2,
      threadRootMessageId: ids.messageReply,
    }
    const content = mapPortableContent(
      inputs({ messages: [reply, root] as unknown as ReadInputs['messages'] })
    )
    expect(content.messages.map((message) => message.messageId)).toEqual([
      ids.messageReply,
      ids.message,
    ])
    expect(content.messages.map((message) => message.channelOrder)).toEqual([1, 2])
    expect(content.messages[1]?.replyToMessageId).toBe(ids.messageReply)
    expect(content.messages[1]?.threadRootMessageId).toBe(ids.messageReply)
  })

  test('a link to a task or channel that is not exported is cleared to null', () => {
    const content = mapPortableContent(
      inputs({
        channels: [
          {
            ...(inputs().channels[0] as object),
            taskId: ids.taskMissing,
          } as unknown as ReadInputs['channels'][number],
        ],
      })
    )
    expect(content.channels[0]?.taskId).toBeNull()
    const task = content.tasks.find((row) => row.taskId === ids.task)
    expect(task?.channelId).toBe(ids.channel)
    const hidden = content.tasks.find((row) => row.taskId === ids.taskHidden)
    expect(hidden?.messageId).toBeNull()
    expect(hidden?.channelId).toBeNull()
  })

  test('only dependencies whose both ends are exported survive, and only cloud-location attempts are kept', () => {
    const content = mapPortableContent(
      inputs({
        attemptRows: [
          {
            attempt: 1,
            change: 'initial',
            createdAt: at,
            locationKind: 'agent_hq_cloud',
            taskId: ids.task,
          },
          {
            attempt: 2,
            change: 'authorized_reroute',
            createdAt: at,
            locationKind: 'local_device',
            taskId: ids.task,
          },
        ] as unknown as ReadInputs['attemptRows'],
        dependencyRows: [
          { dependsOnTaskId: ids.taskHidden, taskId: ids.task },
          { dependsOnTaskId: ids.taskMissing, taskId: ids.task },
        ] as unknown as ReadInputs['dependencyRows'],
      })
    )
    expect(content.executionAttempts).toEqual([
      {
        attempt: 1,
        change: 'initial',
        createdAt: at.toISOString(),
        locationKind: 'agent_hq_cloud',
        taskId: ids.task,
      },
    ])
    expect(content.taskDependencies).toEqual([
      { dependsOnTaskId: ids.taskHidden, taskId: ids.task },
    ])
  })

  test('a content ref is metadata only; availability deleted becomes a deleted body state', () => {
    const content = mapPortableContent(
      inputs({
        contentRefRows: [
          {
            availability: 'deleted',
            contentType: 'message_body',
            createdAt: at,
            digestSha256: 'a'.repeat(64),
            id: ids.contentRef,
            keyVersion: 1,
            messageId: ids.message,
            revision: 1,
            schemaVersion: 1,
            sensitivity: 'sensitive',
            storagePolicy: 'local_authority',
            synchronizationPolicy: 'local_only',
            taskId: null,
            updatedAt: at,
          },
        ] as unknown as ReadInputs['contentRefRows'],
        visibleContentRefIds: new Set([ids.contentRef]),
      })
    )
    expect(content.contentRefs).toEqual([
      expect.objectContaining({
        bodyState: 'deleted',
        contentRefId: ids.contentRef,
        messageId: ids.message,
      }),
    ])
    expect(Object.keys(content.contentRefs[0]!)).not.toContain('availability')
  })

  test('an agent in a project the requester cannot see keeps its identity with no project link', () => {
    const content = mapPortableContent(
      inputs({
        agentRows: [
          {
            createdAt: at,
            id: ids.agent,
            isWorkspaceLead: false,
            lifecycleState: 'active',
            name: 'Researcher',
            profileId: 'profile.research',
            profileRevision: 0,
            profileState: 'available',
            profileVersion: '1.0.0',
            projectId: ids.projectHidden,
            revision: 0,
            roleSummary: null,
            updatedAt: at,
          },
        ] as unknown as ReadInputs['agentRows'],
      })
    )
    expect(content.agents).toEqual([
      expect.objectContaining({ agentId: ids.agent, name: 'Researcher', projectId: null }),
    ])
  })

  test('project members travel as listed, and the workspace record carries no owner field', () => {
    const content = mapPortableContent(
      inputs({
        memberRows: [
          { projectId: ids.project, role: 'editor', userId: ids.user },
        ] as unknown as ReadInputs['memberRows'],
      })
    )
    expect(content.projects[0]?.members).toEqual([{ role: 'editor', userId: ids.user }])
    expect(content.workspace).not.toHaveProperty('ownerUserId')
  })

  test('the built document is a valid version-1 export whose digest covers its content', () => {
    const content = mapPortableContent(inputs())
    const document = buildPortableWorkspaceExport(content, {
      exportedAt: at,
      exportedBy: { role: 'member', userId: ids.user },
    })
    expect(validatePortableWorkspaceExport(document).ok).toBe(true)
    expect(document.contentDigest.value).toBe(portableContentDigest(content))
  })

  test('a document that fails its own contract is refused as an invalid build, not emitted', () => {
    const content = mapPortableContent(inputs())
    const broken = {
      ...content,
      messages: [{ ...content.messages[0]!, channelId: ids.channelHidden }],
    }
    expect(() =>
      buildPortableWorkspaceExport(broken, {
        exportedAt: at,
        exportedBy: { role: 'member', userId: ids.user },
      })
    ).toThrow(PortableExportError)
  })
})

describe('portable export helpers', () => {
  test('a family above the bound fails closed as too large instead of truncating', () => {
    const oversized = Array.from({ length: PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1 }, () => 0)
    expect(() => bounded(oversized, 'messages')).toThrow(PortableExportError)
    expect(bounded([1, 2], 'messages')).toEqual([1, 2])
  })

  test('byKey orders records by their key and groupBy keeps every row under its key in input order', () => {
    expect(byKey([{ k: 'b' }, { k: 'a' }], (row) => row.k)).toEqual([{ k: 'a' }, { k: 'b' }])
    const groups = groupBy(
      [
        { g: 'x', n: 1 },
        { g: 'y', n: 2 },
        { g: 'x', n: 3 },
      ],
      (row) => row.g
    )
    expect(groups.get('x')?.map((row) => row.n)).toEqual([1, 3])
    expect(groups.get('y')?.map((row) => row.n)).toEqual([2])
  })
})
