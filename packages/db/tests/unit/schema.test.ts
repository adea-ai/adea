import { describe, expect, test } from 'bun:test'
import {
  getTableConfig,
  type AnyPgColumn,
  type PgTable,
  type UpdateDeleteAction,
} from 'drizzle-orm/pg-core'

import * as schemaIndex from '../../src/schema'

import {
  agents,
  artifactReferenceGrants,
  artifacts,
  authorizationAuditRecords,
  commandOutbox,
  channelParticipants,
  channels,
  contentRefs,
  contentReplicas,
  desktopAuthorizationCodes,
  eventInbox,
  messageArtifactReferences,
  messageMentions,
  messages,
  projects,
  taskDependencies,
  taskMutations,
  tasks,
  temporaryUserSessions,
  users,
  workspaceMemberships,
  workspaceEvents,
  workspaces,
} from '../../src/schema'

type ReferenceContract = readonly [
  columns: readonly AnyPgColumn[],
  foreignColumns: readonly AnyPgColumn[],
  onDelete: UpdateDeleteAction,
]

function expectReferences(table: PgTable, contracts: readonly ReferenceContract[]) {
  // Drizzle clones source columns for table-level composite keys. Match their
  // owning table by identity and ordered SQL names; referenced columns below
  // must still be the exact exported identity objects.
  const keys = getTableConfig(table).foreignKeys.map((key) => ({ key, reference: key.reference() }))
  expect(keys).toHaveLength(contracts.length)
  for (const [columns, foreignColumns, onDelete] of contracts) {
    const matches = keys.filter(
      ({ reference }) =>
        reference.columns.length === columns.length &&
        reference.columns.every(
          (column, index) =>
            column.table === columns[index]?.table && column.name === columns[index]?.name
        )
    )
    expect(matches).toHaveLength(1)
    const match = matches[0]
    if (!match)
      throw new Error(`Missing foreign key for ${columns.map(({ name }) => name).join(', ')}`)
    expect(match.key.onDelete).toBe(onDelete)
    expect(match.reference.foreignTable).toBe(foreignColumns[0]?.table)
    expect(match.reference.foreignColumns).toHaveLength(foreignColumns.length)
    foreignColumns.forEach((column, index) =>
      expect(match.reference.foreignColumns[index]).toBe(column)
    )
  }
}

describe('persistence schema', () => {
  test('keeps foundational tables in the app schema', () => {
    for (const table of [
      agents,
      artifacts,
      users,
      temporaryUserSessions,
      workspaces,
      workspaceMemberships,
      authorizationAuditRecords,
      workspaceEvents,
      commandOutbox,
      eventInbox,
      projects,
      channels,
      contentRefs,
      channelParticipants,
      messages,
      messageMentions,
      messageArtifactReferences,
      tasks,
      taskDependencies,
      taskMutations,
    ]) {
      expect(getTableConfig(table).schema).toBe('app')
    }
  })

  test('keeps Artifact identity, location, and lifecycle workspace scoped', () => {
    const config = getTableConfig(artifacts)
    expect(config.foreignKeys).toHaveLength(3)
    expect(config.uniqueConstraints).toHaveLength(1)
    expect(config.checks.some(({ name }) => name === 'artifacts_location_consistent')).toBe(true)
    expect(config.checks.some(({ name }) => name === 'artifacts_deletion_consistent')).toBe(true)
    expect(config.indexes.length).toBeGreaterThanOrEqual(4)
  })

  test('keeps product Task state separate from execution and conversation ownership', () => {
    const config = getTableConfig(tasks)
    expect(config.columns.some((column) => column.name === 'version')).toBe(true)
    expect(config.columns.some((column) => column.name === 'control_plane_execution_ref')).toBe(
      true
    )
    expect(config.columns.some((column) => column.name === 'channel_id')).toBe(true)
    expect(config.foreignKeys.map((key) => key.reference().foreignTable)).not.toContain(undefined)
    expect(getTableConfig(taskMutations).uniqueConstraints).toHaveLength(1)
  })

  test('stores only opaque private-content metadata with explicit lifecycle constraints', () => {
    const config = getTableConfig(contentRefs)
    const columns = config.columns.map(({ name }) => name)

    expect(columns).toContain('digest_sha256')
    expect(columns).toContain('synchronization_policy')
    expect(columns).not.toContain('plaintext')
    expect(columns).not.toContain('ciphertext')
    expect(columns).not.toContain('nonce')
    expect(config.checks.some(({ name }) => name === 'content_refs_digest_sha256')).toBe(true)
    expect(config.checks.some(({ name }) => name === 'content_refs_deletion_consistent')).toBe(true)
    expect(config.indexes).toHaveLength(3)
  })

  test('stores ContentReplica ciphertext with physical identity constraints', () => {
    const config = getTableConfig(contentReplicas)
    const columns = config.columns.map(({ name }) => name)

    expect(columns).toContain('content_ref_id')
    expect(columns).toContain('ciphertext')
    expect(columns).toContain('nonce')
    expect(columns).not.toContain('plaintext')
    expect(config.checks.some(({ name }) => name === 'content_replicas_digest_sha256')).toBe(true)
    expect(config.checks.some(({ name }) => name === 'content_replicas_nonce_base64url')).toBe(true)
    expect(config.checks.some(({ name }) => name === 'content_replicas_ciphertext_size')).toBe(true)
    expect(config.checks.some(({ name }) => name === 'content_replicas_ciphertext_canonical')).toBe(
      true
    )
    expect(
      config.checks.some(({ name }) => name === 'content_replicas_kind_epoch_consistent')
    ).toBe(true)
    expect(config.checks.some(({ name }) => name === 'content_replicas_deletion_consistent')).toBe(
      true
    )
    expect(config.indexes).toHaveLength(4)
  })

  test('keeps artifact-reference grant identity complete, positive and tenancy scoped (#1180)', () => {
    const config = getTableConfig(artifactReferenceGrants)
    const columns = config.columns.map(({ name }) => name)

    // The complete presented grant identity must survive end to end.
    for (const column of [
      'grant_id',
      'source_workspace_id',
      'audience_workspace_id',
      'artifact_id',
      'version',
      'checksum_sha256',
      'expires_at',
      'revision',
      'revoked_at',
    ])
      expect(columns).toContain(column)

    // One durable row per grant id; positive store-owned revisions.
    expect(
      config.uniqueConstraints.some((constraint) =>
        constraint.columns.some((column) => column.name === 'grant_id')
      )
    ).toBe(true)
    expect(
      config.checks.some(({ name }) => name === 'artifact_reference_grants_revision_positive')
    ).toBe(true)
    expect(
      config.checks.some(({ name }) => name === 'artifact_reference_grants_version_positive')
    ).toBe(true)
    expect(
      config.checks.some(({ name }) => name === 'artifact_reference_grants_checksum_sha256')
    ).toBe(true)
    expect(
      config.checks.some(({ name }) => name === 'artifact_reference_grants_grant_id_nonempty')
    ).toBe(true)
    expect(
      config.checks.some(({ name }) => name === 'artifact_reference_grants_workspaces_distinct')
    ).toBe(true)
    expect(config.foreignKeys.map((key) => key.reference().foreignTable)).toEqual([
      workspaces,
      workspaces,
    ])
  })

  test('represents constraints and indexes in schema metadata', () => {
    const workspaceEventConfig = getTableConfig(workspaceEvents)
    const commandOutboxConfig = getTableConfig(commandOutbox)
    const eventInboxConfig = getTableConfig(eventInbox)

    expect(workspaceEventConfig.foreignKeys).toHaveLength(1)
    expect(workspaceEventConfig.indexes.length).toBeGreaterThan(0)
    expect(commandOutboxConfig.foreignKeys).toHaveLength(1)
    expect(commandOutboxConfig.indexes.length).toBeGreaterThan(0)
    expect(eventInboxConfig.uniqueConstraints.length).toBeGreaterThan(0)
  })

  test('enforces temporary-session and workspace tenancy boundaries', () => {
    const sessionConfig = getTableConfig(temporaryUserSessions)
    const workspaceConfig = getTableConfig(workspaces)
    const membershipConfig = getTableConfig(workspaceMemberships)

    expect(sessionConfig.foreignKeys).toHaveLength(2)
    expect(sessionConfig.checks.some(({ name }) => name.includes('claim_consistent'))).toBe(true)
    expect(
      sessionConfig.uniqueConstraints.some((constraint) =>
        constraint.columns.some((column) => column.name === 'credential_digest')
      )
    ).toBe(true)
    expect(workspaceConfig.foreignKeys).toHaveLength(1)
    expect(
      workspaceConfig.uniqueConstraints.some((constraint) =>
        constraint.columns.some((column) => column.name === 'idempotency_key')
      )
    ).toBe(true)
    expect(membershipConfig.foreignKeys).toHaveLength(2)
    expect(
      membershipConfig.uniqueConstraints.some(
        (constraint) =>
          constraint.columns.map((column) => column.name).join(':') === 'workspace_id:user_id'
      )
    ).toBe(true)
  })

  test('uses a UUID primary key and a unique digest for desktop authorization codes', () => {
    const config = getTableConfig(desktopAuthorizationCodes)

    expect(config.primaryKeys).toHaveLength(0)
    expect(config.columns.find((column) => column.name === 'id')?.primary).toBe(true)
    expect(
      config.uniqueConstraints.some((constraint) =>
        constraint.columns.some((column) => column.name === 'code_digest')
      )
    ).toBe(true)
  })

  test('keeps project identity workspace scoped without coupling it to channels or scene objects', () => {
    const config = getTableConfig(projects)
    const columns = config.columns.map((column) => column.name)

    expect(config.foreignKeys).toHaveLength(1)
    expect(config.foreignKeys[0]?.reference().foreignTable).toBe(workspaces)
    // A repository is a boolean-level fact; paths, remotes and scene refs never land here.
    expect(columns).toContain('source_kind')
    expect(columns).toContain('deleted_at')
    for (const removed of ['template_key', 'layout_ref', 'spatial_ref', 'channel_id']) {
      expect(columns).not.toContain(removed)
    }
  })

  test('carries no filesystem path: the only location-ish columns are opaque references (#87)', () => {
    // A project is approved on ONE machine, so its canonical path lives in the
    // shell's own bookmark store and must never enter cloud state — a synced
    // path is one machine's filesystem leaking into another's workspace. The
    // allowance below is exhaustive: an Artifact's opaque location (a type plus
    // a reference, not a path) and an OAuth redirect URI. Another appearing
    // fails this test rather than shipping.
    const allowed = [
      'artifacts.location_ref',
      'artifacts.location_type',
      'desktop_authorization_codes.redirect_uri',
      // #671: the *kind* of place that ran an attempt — local_device,
      // remote_host or the reserved cloud location — which is a class of
      // location and not an address. The node it ran on travels as an opaque
      // uuid reference in the column beside it.
      'task_execution_attempts.location_kind',
      // Queue admission keeps the selected local_device/remote_host enum;
      // it contains no endpoint, address or filesystem path.
      'task_submissions.location_kind',
    ]
    const pathish = /(path|dir|directory|absolute|bookmark|mount|volume|location)/i
    const found: string[] = []
    for (const value of Object.values(schemaIndex)) {
      if (!value || typeof value !== 'object') continue
      let config
      try {
        config = getTableConfig(value as never)
      } catch {
        continue
      }
      if (!config?.name) continue
      for (const column of config.columns) {
        if (pathish.test(column.name)) found.push(`${config.name}.${column.name}`)
      }
    }
    expect(found.toSorted()).toEqual(allowed.toSorted())
  })
  test('preserves conversation evidence while participant and mention rows follow deletion', () => {
    expectReferences(channels, [
      [[channels.workspaceId], [workspaces.id], 'cascade'],
      [[channels.projectId], [projects.id], 'restrict'],
      [[channels.agentId], [agents.id], 'set null'],
      [[channels.taskId], [tasks.id], 'set null'],
    ])
    // Message bodies, senders and reply ancestors remain referenced evidence;
    // deleting a Task only detaches its optional conversation association.
    expectReferences(messages, [
      [[messages.workspaceId], [workspaces.id], 'cascade'],
      [[messages.channelId], [channels.id], 'restrict'],
      [[messages.senderUserId], [users.id], 'restrict'],
      [[messages.senderAgentId], [agents.id], 'restrict'],
      [[messages.bodyContentRefId], [contentRefs.id], 'restrict'],
      [[messages.threadRootMessageId], [messages.id], 'restrict'],
      [[messages.replyToMessageId], [messages.id], 'restrict'],
      [[messages.taskId], [tasks.id], 'set null'],
    ])
    expectReferences(channelParticipants, [
      [[channelParticipants.workspaceId], [workspaces.id], 'cascade'],
      [[channelParticipants.channelId], [channels.id], 'cascade'],
      [[channelParticipants.userId], [users.id], 'cascade'],
      [[channelParticipants.agentId], [agents.id], 'cascade'],
    ])
    expectReferences(messageMentions, [
      [[messageMentions.workspaceId], [workspaces.id], 'cascade'],
      [[messageMentions.messageId], [messages.id], 'cascade'],
      [[messageMentions.userId], [users.id], 'cascade'],
      [[messageMentions.agentId], [agents.id], 'cascade'],
    ])
    expectReferences(messageArtifactReferences, [
      [[messageArtifactReferences.workspaceId], [workspaces.id], 'cascade'],
      [[messageArtifactReferences.messageId], [messages.id], 'cascade'],
      [[messageArtifactReferences.artifactId], [artifacts.id], 'restrict'],
    ])
  })

  test('binds live group grants to principals while preserving quarantined principal provenance', () => {
    const {
      groupAdmissions,
      groupAudienceGrants,
      groupEnlistmentGrants,
      groupSharingGrants,
      legacyAudienceQuarantine,
    } = schemaIndex
    expectReferences(groupAudienceGrants, [
      [[groupAudienceGrants.workspaceId], [workspaces.id], 'cascade'],
      [[groupAudienceGrants.channelId], [channels.id], 'cascade'],
      [[groupAudienceGrants.userId], [users.id], 'cascade'],
    ])
    expectReferences(groupEnlistmentGrants, [
      [[groupEnlistmentGrants.workspaceId], [workspaces.id], 'cascade'],
      [[groupEnlistmentGrants.channelId], [channels.id], 'cascade'],
      [[groupEnlistmentGrants.agentId], [agents.id], 'cascade'],
    ])
    expectReferences(groupSharingGrants, [
      [[groupSharingGrants.workspaceId], [workspaces.id], 'cascade'],
      [[groupSharingGrants.channelId], [channels.id], 'cascade'],
      [[groupSharingGrants.userId], [users.id], 'cascade'],
      [[groupSharingGrants.agentId], [agents.id], 'cascade'],
    ])
    expectReferences(groupAdmissions, [
      [[groupAdmissions.workspaceId], [workspaces.id], 'cascade'],
      [[groupAdmissions.channelId], [channels.id], 'cascade'],
      [[groupAdmissions.userId], [users.id], 'cascade'],
      [[groupAdmissions.agentId], [agents.id], 'cascade'],
    ])
    // Exactly these two references: removing a former principal must not
    // cascade away the quarantine evidence that keeps that audience denied.
    expectReferences(legacyAudienceQuarantine, [
      [[legacyAudienceQuarantine.workspaceId], [workspaces.id], 'cascade'],
      [[legacyAudienceQuarantine.channelId], [channels.id], 'cascade'],
    ])
  })

  test('keeps task creator, private objective and execution-node history attached to their identities', () => {
    const { taskExecutionAttempts, runtimeNodes } = schemaIndex
    expectReferences(tasks, [
      [[tasks.workspaceId], [workspaces.id], 'cascade'],
      [[tasks.creatorUserId], [users.id], 'restrict'],
      [[tasks.agentId], [agents.id], 'set null'],
      [[tasks.projectId], [projects.id], 'set null'],
      [[tasks.objectiveContentRefId], [contentRefs.id], 'restrict'],
    ])
    expectReferences(taskDependencies, [
      [[taskDependencies.workspaceId], [workspaces.id], 'cascade'],
      [[taskDependencies.taskId], [tasks.id], 'cascade'],
      [[taskDependencies.dependsOnTaskId], [tasks.id], 'cascade'],
    ])
    expectReferences(taskMutations, [
      [[taskMutations.workspaceId], [workspaces.id], 'cascade'],
      [[taskMutations.taskId], [tasks.id], 'cascade'],
    ])
    expectReferences(taskExecutionAttempts, [
      [[taskExecutionAttempts.workspaceId], [workspaces.id], 'cascade'],
      [[taskExecutionAttempts.taskId], [tasks.id], 'cascade'],
      [[taskExecutionAttempts.runtimeNodeId], [runtimeNodes.id], 'restrict'],
    ])
  })

  test('binds runtime credentials and delivery requests to the intended node and workspace', () => {
    const {
      runtimeNodes,
      runtimeNodeKeys,
      runtimeNodeChallenges,
      runtimeNodeExchangeCredentials,
      runtimeNodeDeliveryRequests,
    } = schemaIndex
    expectReferences(runtimeNodes, [
      [[runtimeNodes.workspaceId], [workspaces.id], 'cascade'],
      [[runtimeNodes.ownerUserId], [users.id], 'restrict'],
    ])
    expectReferences(runtimeNodeKeys, [
      [[runtimeNodeKeys.runtimeNodeId], [runtimeNodes.id], 'cascade'],
    ])
    expectReferences(runtimeNodeChallenges, [
      [[runtimeNodeChallenges.workspaceId], [workspaces.id], 'cascade'],
      [[runtimeNodeChallenges.runtimeNodeId], [runtimeNodes.id], 'cascade'],
      [[runtimeNodeChallenges.createdByUserId], [users.id], 'cascade'],
    ])
    expectReferences(runtimeNodeExchangeCredentials, [
      [[runtimeNodeExchangeCredentials.workspaceId], [workspaces.id], 'cascade'],
      [[runtimeNodeExchangeCredentials.challengeId], [runtimeNodeChallenges.id], 'cascade'],
    ])
    expectReferences(runtimeNodeDeliveryRequests, [
      [[runtimeNodeDeliveryRequests.signingKeyId], [runtimeNodeKeys.id], 'no action'],
      [
        [runtimeNodeDeliveryRequests.workspaceId, runtimeNodeDeliveryRequests.runtimeNodeId],
        [runtimeNodes.workspaceId, runtimeNodes.id],
        'cascade',
      ],
    ])
  })

  test('scopes read cursors to their workspace, reader, conversation and thread ancestor', () => {
    const { channelReadStates, threadReadStates } = schemaIndex
    expectReferences(channelReadStates, [
      [[channelReadStates.workspaceId], [workspaces.id], 'cascade'],
      [[channelReadStates.userId], [users.id], 'cascade'],
      [[channelReadStates.channelId], [channels.id], 'cascade'],
    ])
    expectReferences(threadReadStates, [
      [[threadReadStates.workspaceId], [workspaces.id], 'cascade'],
      [[threadReadStates.userId], [users.id], 'cascade'],
      [[threadReadStates.channelId], [channels.id], 'cascade'],
      [[threadReadStates.threadRootMessageId], [messages.id], 'cascade'],
    ])
  })

  test('retains deletion authority, holds and executor evidence instead of cascading audit history', () => {
    const {
      retentionHolds,
      retentionDeletionAuthorizations,
      retentionCleanupReceipts,
      retentionDeletionDispatches,
      runtimeNodes,
    } = schemaIndex
    expectReferences(retentionHolds, [
      [[retentionHolds.workspaceId], [workspaces.id], 'restrict'],
      [[retentionHolds.placedByUserId], [users.id], 'restrict'],
      [[retentionHolds.releasedByUserId], [users.id], 'restrict'],
    ])
    expectReferences(retentionDeletionAuthorizations, [
      [[retentionDeletionAuthorizations.workspaceId], [workspaces.id], 'restrict'],
      [[retentionDeletionAuthorizations.grantedByUserId], [users.id], 'restrict'],
      [[retentionDeletionAuthorizations.revokedByUserId], [users.id], 'restrict'],
    ])
    expectReferences(retentionCleanupReceipts, [
      [[retentionCleanupReceipts.workspaceId], [workspaces.id], 'restrict'],
      [
        [retentionCleanupReceipts.authorizationId],
        [retentionDeletionAuthorizations.id],
        'restrict',
      ],
      [
        [retentionCleanupReceipts.workspaceId, retentionCleanupReceipts.runtimeNodeId],
        [runtimeNodes.workspaceId, runtimeNodes.id],
        'no action',
      ],
    ])
    expectReferences(retentionDeletionDispatches, [
      [[retentionDeletionDispatches.workspaceId], [workspaces.id], 'restrict'],
      [
        [retentionDeletionDispatches.authorizationId],
        [retentionDeletionAuthorizations.id],
        'restrict',
      ],
    ])
  })
  test('retains workspace and temporary-claim ownership while user credentials follow their account', () => {
    const { authIdentities, desktopSessions, workspaceInvitations, workspaceDeletions } =
      schemaIndex
    expectReferences(workspaces, [[[workspaces.ownerUserId], [users.id], 'restrict']])
    expectReferences(workspaceMemberships, [
      [[workspaceMemberships.workspaceId], [workspaces.id], 'restrict'],
      [[workspaceMemberships.userId], [users.id], 'restrict'],
    ])
    expectReferences(workspaceInvitations, [
      [[workspaceInvitations.workspaceId], [workspaces.id], 'cascade'],
      [[workspaceInvitations.invitedByUserId], [users.id], 'restrict'],
      [[workspaceInvitations.acceptedByUserId], [users.id], 'restrict'],
    ])
    expectReferences(workspaceDeletions, [
      [[workspaceDeletions.ownerUserId], [users.id], 'cascade'],
    ])
    expectReferences(temporaryUserSessions, [
      [[temporaryUserSessions.userId], [users.id], 'restrict'],
      [[temporaryUserSessions.claimedByUserId], [users.id], 'restrict'],
    ])
    expectReferences(authIdentities, [[[authIdentities.userId], [users.id], 'cascade']])
    expectReferences(desktopAuthorizationCodes, [
      [[desktopAuthorizationCodes.userId], [users.id], 'cascade'],
    ])
    expectReferences(desktopSessions, [[[desktopSessions.userId], [users.id], 'cascade']])
  })

  test('keeps physical content in its owning workspace and detaches optional project associations', () => {
    const { projectMembers } = schemaIndex
    expectReferences(contentRefs, [[[contentRefs.workspaceId], [workspaces.id], 'cascade']])
    expectReferences(contentReplicas, [
      [[contentReplicas.workspaceId], [workspaces.id], 'cascade'],
      [
        [contentReplicas.workspaceId, contentReplicas.contentRefId],
        [contentRefs.workspaceId, contentRefs.id],
        'cascade',
      ],
    ])
    expectReferences(artifacts, [
      [[artifacts.workspaceId], [workspaces.id], 'cascade'],
      [[artifacts.taskId], [tasks.id], 'set null'],
      [[artifacts.agentId], [agents.id], 'set null'],
    ])
    // Source and audience both need independent workspace foreign keys;
    // collapsing either reference onto the other column must fail.
    expectReferences(artifactReferenceGrants, [
      [[artifactReferenceGrants.sourceWorkspaceId], [workspaces.id], 'cascade'],
      [[artifactReferenceGrants.audienceWorkspaceId], [workspaces.id], 'cascade'],
    ])
    expectReferences(agents, [
      [[agents.workspaceId], [workspaces.id], 'cascade'],
      [[agents.projectId], [projects.id], 'set null'],
    ])
    expectReferences(projects, [[[projects.workspaceId], [workspaces.id], 'cascade']])
    expectReferences(projectMembers, [
      [[projectMembers.workspaceId], [workspaces.id], 'cascade'],
      [[projectMembers.projectId], [projects.id], 'cascade'],
      [[projectMembers.userId], [users.id], 'cascade'],
    ])
  })

  test('keeps event dispatch and authority consumption workspace bound without cascading audit principals', () => {
    const { workspaceEventDispatches, workspaceEventSequences, managementAuthorityConsumptions } =
      schemaIndex
    expectReferences(workspaceEvents, [[[workspaceEvents.workspaceId], [workspaces.id], 'cascade']])
    expectReferences(workspaceEventSequences, [
      [[workspaceEventSequences.workspaceId], [workspaces.id], 'cascade'],
    ])
    expectReferences(workspaceEventDispatches, [
      [[workspaceEventDispatches.workspaceId], [workspaces.id], 'cascade'],
      [[workspaceEventDispatches.eventId], [workspaceEvents.id], 'cascade'],
    ])
    expectReferences(commandOutbox, [[[commandOutbox.workspaceId], [workspaces.id], 'cascade']])
    expectReferences(managementAuthorityConsumptions, [
      [[managementAuthorityConsumptions.workspaceId], [workspaces.id], 'cascade'],
    ])
    // Audit and remote inbox provenance is stored without a cascading local
    // principal relationship; deleting an account must not erase that record.
    expectReferences(authorizationAuditRecords, [])
    expectReferences(eventInbox, [])
  })

  test('retains admitted turn and published-message provenance when referenced principals are deleted', () => {
    const { addressedAgentTurns, leadTurnIntents, leadTurnRuntime } = schemaIndex
    expectReferences(addressedAgentTurns, [
      [[addressedAgentTurns.workspaceId], [workspaces.id], 'restrict'],
      [[addressedAgentTurns.channelId], [channels.id], 'restrict'],
      [[addressedAgentTurns.triggerMessageId], [messages.id], 'restrict'],
      [[addressedAgentTurns.agentId], [agents.id], 'restrict'],
      [[addressedAgentTurns.addresserUserId], [users.id], 'restrict'],
      [[addressedAgentTurns.responseMessageId], [messages.id], 'restrict'],
      [[addressedAgentTurns.intentId], [leadTurnIntents.id], 'restrict'],
    ])
    expectReferences(leadTurnIntents, [
      [[leadTurnIntents.workspaceId], [workspaces.id], 'restrict'],
      [[leadTurnIntents.channelId], [channels.id], 'restrict'],
      [[leadTurnIntents.messageId], [messages.id], 'restrict'],
      [[leadTurnIntents.actorUserId], [users.id], 'restrict'],
      [[leadTurnIntents.agentId], [agents.id], 'restrict'],
    ])
    expectReferences(leadTurnRuntime, [
      [[leadTurnRuntime.intentId], [leadTurnIntents.id], 'restrict'],
      [[leadTurnRuntime.publishedMessageId], [messages.id], 'restrict'],
    ])
  })

  test('binds coordination revisions and citations to the exact plan, workspace, channel and revision', () => {
    const { coordinationPlans, coordinationPlanRevisions, coordinationPlanCitations } = schemaIndex
    expectReferences(coordinationPlans, [
      [[coordinationPlans.workspaceId], [workspaces.id], 'restrict'],
      [[coordinationPlans.channelId], [channels.id], 'restrict'],
      [[coordinationPlans.createdByUserId], [users.id], 'restrict'],
    ])
    expectReferences(coordinationPlanRevisions, [
      [[coordinationPlanRevisions.authorUserId], [users.id], 'restrict'],
      [
        [
          coordinationPlanRevisions.planId,
          coordinationPlanRevisions.workspaceId,
          coordinationPlanRevisions.channelId,
        ],
        [coordinationPlans.id, coordinationPlans.workspaceId, coordinationPlans.channelId],
        'restrict',
      ],
    ])
    expectReferences(coordinationPlanCitations, [
      [
        [coordinationPlanCitations.planId, coordinationPlanCitations.revision],
        [coordinationPlanRevisions.planId, coordinationPlanRevisions.revision],
        'restrict',
      ],
    ])
  })

  test('keeps queued task, agent, runtime node and command references in the submission workspace', () => {
    const { taskSubmissions, runtimeNodes } = schemaIndex
    expectReferences(taskSubmissions, [
      [[taskSubmissions.workspaceId], [workspaces.id], 'cascade'],
      [[taskSubmissions.actorUserId], [users.id], 'restrict'],
      [
        [taskSubmissions.workspaceId, taskSubmissions.taskId],
        [tasks.workspaceId, tasks.id],
        'cascade',
      ],
      [
        [taskSubmissions.workspaceId, taskSubmissions.agentId],
        [agents.workspaceId, agents.id],
        'no action',
      ],
      [
        [taskSubmissions.workspaceId, taskSubmissions.runtimeNodeId],
        [runtimeNodes.workspaceId, runtimeNodes.id],
        'no action',
      ],
      [
        [taskSubmissions.workspaceId, taskSubmissions.commandId],
        [commandOutbox.workspaceId, commandOutbox.id],
        'no action',
      ],
    ])
  })
})
