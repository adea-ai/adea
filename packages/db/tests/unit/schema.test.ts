import { describe, expect, test } from 'bun:test'
import { getTableConfig } from 'drizzle-orm/pg-core'

import {
  agents,
  authorizationAuditRecords,
  commandOutbox,
  desktopAuthorizationCodes,
  eventInbox,
  rooms,
  temporaryUserSessions,
  users,
  workspaceMemberships,
  workspaceEvents,
  workspaces,
} from '../../src/schema'

describe('persistence schema', () => {
  test('keeps foundational tables in the app schema', () => {
    for (const table of [
      agents,
      users,
      temporaryUserSessions,
      workspaces,
      workspaceMemberships,
      authorizationAuditRecords,
      workspaceEvents,
      commandOutbox,
      eventInbox,
      rooms,
    ]) {
      expect(getTableConfig(table).schema).toBe('app')
    }
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

  test('keeps room identity workspace scoped without coupling it to channels or scene objects', () => {
    const config = getTableConfig(rooms)

    expect(config.foreignKeys).toHaveLength(1)
    expect(config.foreignKeys[0]?.reference().foreignTable).toBe(workspaces)
    expect(config.columns.some((column) => column.name === 'layout_ref')).toBe(true)
    expect(config.columns.some((column) => column.name === 'spatial_ref')).toBe(true)
    expect(config.columns.some((column) => column.name === 'channel_id')).toBe(false)
  })
})
