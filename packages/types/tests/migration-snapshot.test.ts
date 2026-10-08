import { describe, expect, test } from 'bun:test'

import {
  isMigrationSnapshotFamily,
  MIGRATION_SNAPSHOT_FORMAT_VERSION,
  migrationAgentLifecycleStates,
  migrationChannelVisibilities,
  migrationContentAvailabilities,
  migrationExecutionLocationKinds,
  migrationInvitationRoles,
  migrationInvitationStates,
  migrationParticipantKinds,
  migrationProjectMemberRoles,
  migrationProjectVisibilities,
  migrationSnapshotFamilies,
  migrationSnapshotFindingClasses,
  migrationSnapshotFindingDetailKeys,
  migrationSnapshotRecordIssue,
  migrationTaskLifecycleStates,
  migrationWorkspaceRoles,
  type MigrationSnapshotRecord,
} from '../src/migration-snapshot'

/** One minimal, valid record per family. */
function validRecord(family: (typeof migrationSnapshotFamilies)[number]): MigrationSnapshotRecord {
  switch (family) {
    case 'agents':
      return {
        agentId: 'agent-1',
        family: 'agents',
        lifecycleState: 'active',
        projectId: null,
        workspaceId: 'wsp-1',
      }
    case 'channelParticipants':
      return {
        channelId: 'ch-1',
        family: 'channelParticipants',
        principalId: 'user-1',
        principalKind: 'user',
        workspaceId: 'wsp-1',
      }
    case 'channels':
      return {
        channelId: 'ch-1',
        family: 'channels',
        projectId: null,
        visibility: 'workspace',
        workspaceId: 'wsp-1',
      }
    case 'contentRefs':
      return {
        availability: 'available',
        contentRefId: 'cref-1',
        digestSha256: 'a'.repeat(64),
        family: 'contentRefs',
        keyVersion: 1,
        messageId: null,
        revision: 1,
        taskId: null,
        workspaceId: 'wsp-1',
      }
    case 'events':
      return {
        eventId: 'evt-1',
        eventType: 'workspace.created',
        family: 'events',
        payloadDigest: 'b'.repeat(64),
        schemaVersion: 1,
        workspaceId: 'wsp-1',
        workspaceSequence: 1,
      }
    case 'executionAttempts':
      return {
        attempt: 1,
        family: 'executionAttempts',
        locationKind: 'local_device',
        runtimeNodeId: 'node-1',
        taskId: 'task-1',
        workspaceId: 'wsp-1',
      }
    case 'identityBindings':
      return {
        family: 'identityBindings',
        provider: 'google',
        subject: 'subject-1',
        userId: 'user-1',
      }
    case 'invitations':
      return {
        family: 'invitations',
        invitationId: 'inv-1',
        invitedByUserId: 'user-1',
        role: 'member',
        state: 'pending',
        workspaceId: 'wsp-1',
      }
    case 'memberships':
      return { family: 'memberships', role: 'member', userId: 'user-1', workspaceId: 'wsp-1' }
    case 'messages':
      return {
        channelId: 'ch-1',
        deleted: false,
        family: 'messages',
        messageId: 'msg-1',
        threadRootMessageId: null,
        workspaceId: 'wsp-1',
      }
    case 'projectMembers':
      return {
        family: 'projectMembers',
        projectId: 'prj-1',
        role: 'viewer',
        userId: 'user-1',
        workspaceId: 'wsp-1',
      }
    case 'projects':
      return {
        family: 'projects',
        projectId: 'prj-1',
        visibility: 'workspace',
        workspaceId: 'wsp-1',
      }
    case 'readState':
      return {
        channelId: 'ch-1',
        family: 'readState',
        lastReadSequence: 5,
        manuallyUnread: false,
        threadRootMessageId: null,
        userId: 'user-1',
        workspaceId: 'wsp-1',
      }
    case 'tasks':
      return {
        channelId: null,
        creatorUserId: 'user-1',
        family: 'tasks',
        lifecycleState: 'created',
        messageId: null,
        projectId: null,
        taskId: 'task-1',
        threadRootMessageId: null,
        version: 1,
        workspaceId: 'wsp-1',
      }
    case 'temporarySessions':
      return { claimed: false, family: 'temporarySessions', sessionId: 'sess-1', userId: 'user-1' }
    case 'workspaces':
      return {
        archived: false,
        controlPlaneWorkspaceId: 'wsp_01AAAAAAAAAAAAAAAAAAAAAAAA',
        family: 'workspaces',
        ownerUserId: 'user-1',
        workspaceId: 'wsp-1',
      }
  }
}

function withField(record: MigrationSnapshotRecord, field: string, value: unknown) {
  return { ...record, [field]: value } as MigrationSnapshotRecord
}

function withoutField(record: MigrationSnapshotRecord, field: string) {
  const copy = { ...record } as Record<string, unknown>
  delete copy[field]
  return copy as MigrationSnapshotRecord
}

function isSorted(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value)
}

describe('migration snapshot contract constants', () => {
  test('the snapshot format version is pinned at 1', () => {
    expect(MIGRATION_SNAPSHOT_FORMAT_VERSION).toBe(1)
    expect(Number.isInteger(MIGRATION_SNAPSHOT_FORMAT_VERSION)).toBe(true)
  })

  test('every record family a migration must inventory is present, sorted and unique', () => {
    expect(migrationSnapshotFamilies.length).toBe(16)
    expect(isSorted([...migrationSnapshotFamilies])).toBe(true)
    expect(new Set(migrationSnapshotFamilies).size).toBe(migrationSnapshotFamilies.length)
    for (const family of [
      'agents',
      'channelParticipants',
      'channels',
      'contentRefs',
      'events',
      'executionAttempts',
      'identityBindings',
      'invitations',
      'memberships',
      'messages',
      'projectMembers',
      'projects',
      'readState',
      'tasks',
      'temporarySessions',
      'workspaces',
    ]) {
      expect(isMigrationSnapshotFamily(family)).toBe(true)
    }
    expect(isMigrationSnapshotFamily('groupPolicy')).toBe(false)
    expect(isMigrationSnapshotFamily(42)).toBe(false)
  })

  test('finding classes cover every required violation plus the epistemic ones', () => {
    expect(isSorted([...migrationSnapshotFindingClasses])).toBe(true)
    for (const required of [
      'missing_record',
      'unexpected_record',
      'duplicated_record',
      'remapped_record',
      'digest_drift',
      'widened_access',
      'lost_read_state',
      'conflicting_attempt_owner',
    ]) {
      expect(migrationSnapshotFindingClasses).toContain(required)
    }
    for (const epistemic of ['unknown_domain', 'quarantined_record', 'truncated_input']) {
      expect(migrationSnapshotFindingClasses).toContain(epistemic)
    }
  })

  test('finding details may only carry the allow-listed keys', () => {
    expect([...migrationSnapshotFindingDetailKeys].toSorted()).toEqual([
      'after',
      'before',
      'count',
      'field',
      'reason',
    ])
  })

  test('every enum list is sorted and free of blank values', () => {
    const lists = [
      migrationAgentLifecycleStates,
      migrationChannelVisibilities,
      migrationContentAvailabilities,
      migrationExecutionLocationKinds,
      migrationInvitationRoles,
      migrationInvitationStates,
      migrationParticipantKinds,
      migrationProjectMemberRoles,
      migrationProjectVisibilities,
      migrationTaskLifecycleStates,
      migrationWorkspaceRoles,
    ]
    for (const list of lists) {
      expect(list.length).toBeGreaterThan(0)
      expect(isSorted([...list])).toBe(true)
      for (const value of list) expect(value.length).toBeGreaterThan(0)
    }
  })
})

describe('migration snapshot record validation', () => {
  test('accepts one minimal valid record from every family', () => {
    for (const family of migrationSnapshotFamilies) {
      expect(migrationSnapshotRecordIssue(validRecord(family))).toBeNull()
    }
  })

  test('a record of an unknown family is malformed, never guessed', () => {
    const impostor = {
      ...validRecord('memberships'),
      family: 'groupPolicy',
    } as MigrationSnapshotRecord
    expect(migrationSnapshotRecordIssue(impostor)).toEqual({ field: 'family', kind: 'malformed' })
  })

  test('a missing or wrongly typed required field is malformed and names the field', () => {
    const cases: readonly [MigrationSnapshotRecord, string][] = [
      [withoutField(validRecord('workspaces'), 'ownerUserId'), 'ownerUserId'],
      [withoutField(validRecord('memberships'), 'userId'), 'userId'],
      [withField(validRecord('memberships'), 'userId', 42), 'userId'],
      [withoutField(validRecord('messages'), 'deleted'), 'deleted'],
      [withField(validRecord('messages'), 'deleted', 'no'), 'deleted'],
      [withoutField(validRecord('events'), 'payloadDigest'), 'payloadDigest'],
      [withField(validRecord('events'), 'workspaceSequence', -1), 'workspaceSequence'],
      [withField(validRecord('events'), 'workspaceSequence', 1.5), 'workspaceSequence'],
      [withField(validRecord('readState'), 'lastReadSequence', -3), 'lastReadSequence'],
      [withoutField(validRecord('tasks'), 'version'), 'version'],
      [withField(validRecord('tasks'), 'version', 0), 'version'],
      [withoutField(validRecord('identityBindings'), 'subject'), 'subject'],
      [withField(validRecord('temporarySessions'), 'claimed', null), 'claimed'],
      [withField(validRecord('contentRefs'), 'digestSha256', 'not-a-digest'), 'digestSha256'],
      [withField(validRecord('contentRefs'), 'revision', -1), 'revision'],
      [withField(validRecord('agents'), 'projectId', 7), 'projectId'],
      [withField(validRecord('executionAttempts'), 'attempt', 0), 'attempt'],
      [withoutField(validRecord('invitations'), 'state'), 'state'],
      [withoutField(validRecord('projectMembers'), 'role'), 'role'],
      [withoutField(validRecord('channels'), 'visibility'), 'visibility'],
      [withoutField(validRecord('projects'), 'workspaceId'), 'workspaceId'],
      [withoutField(validRecord('channelParticipants'), 'principalId'), 'principalId'],
    ]
    for (const [record, field] of cases) {
      const issue = migrationSnapshotRecordIssue(record)
      expect(issue).not.toBeNull()
      expect(issue?.kind).toBe('malformed')
      expect(issue?.field).toBe(field)
    }
  })

  test('ambiguous audience and ownership values are quarantined as ambiguous, not malformed', () => {
    const cases: readonly [MigrationSnapshotRecord, string][] = [
      [withField(validRecord('memberships'), 'role', 'superuser'), 'role'],
      [withField(validRecord('projectMembers'), 'role', 'owner'), 'role'],
      [withField(validRecord('invitations'), 'role', 'guest'), 'role'],
      [withField(validRecord('projects'), 'visibility', 'everyone'), 'visibility'],
      [withField(validRecord('channels'), 'visibility', 'secret'), 'visibility'],
      [withField(validRecord('channelParticipants'), 'principalKind', 'ghost'), 'principalKind'],
      [withField(validRecord('agents'), 'lifecycleState', 'zombie'), 'lifecycleState'],
      [withField(validRecord('tasks'), 'lifecycleState', 'deleted'), 'lifecycleState'],
      [withField(validRecord('contentRefs'), 'availability', 'cached'), 'availability'],
      [withField(validRecord('executionAttempts'), 'locationKind', 'orbit'), 'locationKind'],
      [
        // The reserved cloud location must own no node; any other location
        // must own exactly one.
        withField(validRecord('executionAttempts'), 'runtimeNodeId', null),
        'runtimeNodeId',
      ],
      [
        withField(
          withField(validRecord('executionAttempts'), 'locationKind', 'agent_hq_cloud'),
          'runtimeNodeId',
          'node-1'
        ),
        'runtimeNodeId',
      ],
    ]
    for (const [record, field] of cases) {
      const issue = migrationSnapshotRecordIssue(record)
      expect(issue).not.toBeNull()
      expect(issue?.kind).toBe('ambiguous')
      expect(issue?.field).toBe(field)
    }
  })

  test('a quarantined issue names the field but never echoes the offending value', () => {
    const issue = migrationSnapshotRecordIssue(
      withField(validRecord('memberships'), 'role', 'SUPERUSER_SECRET_MARKER')
    )
    expect(issue).toEqual({ field: 'role', kind: 'ambiguous' })
    expect(JSON.stringify(issue)).not.toContain('SUPERUSER_SECRET_MARKER')
  })
})
