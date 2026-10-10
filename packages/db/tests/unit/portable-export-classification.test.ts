import { describe, expect, test } from 'bun:test'
import { getTableName, is } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'

import { PORTABLE_WORKSPACE_EXPORT_EXCLUSIONS } from '@adea-ai/types'

import * as schema from '../../src/schema'

// Every table in the app schema is either carried by the portable export
// (`portable`, with the family or column group it feeds) or named in the
// exclusion ledger with its class. A new table therefore fails this test until
// someone decides how it travels, so nothing reaches an export by default.
const portable: Readonly<Record<string, string>> = {
  agents: 'agents',
  channel_participants: 'channels.participants',
  channels: 'channels',
  content_refs: 'contentRefs',
  message_mentions: 'messages.mentions',
  messages: 'messages',
  project_members: 'projects.members',
  projects: 'projects',
  task_dependencies: 'taskDependencies',
  task_execution_attempts: 'executionAttempts',
  tasks: 'tasks',
  users: 'users',
  workspaces: 'workspace',
}

const excluded: Readonly<Record<string, string>> = {
  artifact_reference_grants: 'artifact_bytes_and_locations',
  artifacts: 'artifact_bytes_and_locations',
  auth_identities: 'credentials',
  authorization_audit_records: 'derived_and_personal_state',
  channel_read_states: 'derived_and_personal_state',
  command_outbox: 'derived_and_personal_state',
  content_replicas: 'e2e_ciphertext_replicas',
  desktop_authorization_codes: 'credentials',
  desktop_sessions: 'credentials',
  event_inbox: 'derived_and_personal_state',
  lead_turn_intents: 'runtime_execution_state',
  lead_turn_runtime: 'runtime_execution_state',
  message_artifact_references: 'artifact_bytes_and_locations',
  runtime_node_challenges: 'credentials',
  runtime_node_delivery_requests: 'runtime_execution_state',
  runtime_node_exchange_credentials: 'credentials',
  runtime_node_keys: 'credentials',
  runtime_nodes: 'runtime_execution_state',
  task_mutations: 'derived_and_personal_state',
  task_submissions: 'runtime_execution_state',
  temporary_user_sessions: 'credentials',
  thread_read_states: 'derived_and_personal_state',
  workspace_deletions: 'soft_deleted_records',
  workspace_event_dispatches: 'derived_and_personal_state',
  workspace_event_sequences: 'derived_and_personal_state',
  workspace_events: 'derived_and_personal_state',
  workspace_invitations: 'credentials',
  workspace_memberships: 'authority_grants',
}

describe('portable export coverage of the app schema', () => {
  const tableNames = Object.values(schema)
    .filter((value): value is PgTable => is(value, PgTable))
    .map((table) => getTableName(table))
    .toSorted()

  test('classifies every app table exactly once', () => {
    for (const name of tableNames) {
      const classes = [name in portable, name in excluded].filter(Boolean).length
      expect({ name, classes }).toEqual({ name, classes: 1 })
    }
  })

  test('names no stale table in either classification', () => {
    const known = new Set(tableNames)
    for (const name of [...Object.keys(portable), ...Object.keys(excluded)])
      expect(known.has(name)).toBe(true)
  })

  test('uses only classes the version-1 ledger declares', () => {
    const declared = new Set(PORTABLE_WORKSPACE_EXPORT_EXCLUSIONS.map((entry) => entry.class))
    for (const className of Object.values(excluded)) expect(declared.has(className)).toBe(true)
  })
})
