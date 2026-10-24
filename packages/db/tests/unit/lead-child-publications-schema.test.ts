import { describe, expect, test } from 'bun:test'

import { getTableConfig } from 'drizzle-orm/pg-core'

import { leadChildPublications, messages, leadTurnIntents } from '../../src/schema'

describe('lead child publication receipt schema', () => {
  test('is keyed by intent and delegation and points at the intent and its message', () => {
    const config = getTableConfig(leadChildPublications)

    expect(config.schema).toBe('app')
    expect(config.name).toBe('lead_child_publications')
    expect(config.primaryKeys).toHaveLength(1)
    expect(config.primaryKeys[0]!.columns.map(({ name }) => name)).toEqual([
      'intent_id',
      'delegation_id',
    ])
    expect(config.foreignKeys).toHaveLength(2)

    const references = config.foreignKeys.map((foreignKey) => {
      const { columns, foreignColumns } = foreignKey.reference()
      return {
        local: columns.map(({ name }) => name),
        table: getTableConfig(foreignColumns[0]!.table).name,
        column: foreignColumns[0]!.name,
        onDelete: foreignKey.onDelete,
      }
    })
    expect(references).toEqual(
      expect.arrayContaining([
        {
          local: ['intent_id'],
          table: getTableConfig(leadTurnIntents).name,
          column: 'id',
          onDelete: 'restrict',
        },
        {
          local: ['message_id'],
          table: getTableConfig(messages).name,
          column: 'id',
          onDelete: 'restrict',
        },
      ])
    )
  })

  test('refuses malformed identities and digests in the database, not only in the transaction', () => {
    const config = getTableConfig(leadChildPublications)
    const checks = config.checks.map(({ name }) => name)

    expect(checks).toEqual([
      'lead_child_publications_delegation_valid',
      'lead_child_publications_execution_valid',
      'lead_child_publications_attempt_valid',
      'lead_child_publications_digest_valid',
    ])
  })
})
