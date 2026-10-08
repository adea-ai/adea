import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createDatabase, type DatabaseConnection } from '../../src/connection'

let connection: DatabaseConnection
beforeAll(() => {
  if (process.env.DATABASE_URL) connection = createDatabase(process.env.DATABASE_URL)
})
afterAll(async () => {
  await connection?.close()
})

test.skipIf(!process.env.DATABASE_URL)(
  'workspace expansion preserves relay retention and constrains the future personal root',
  async () => {
    const columns = await connection.client<Array<{ column_name: string }>>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = 'workspaces'
  `
    expect(columns.map((row) => row.column_name)).toEqual(
      expect.arrayContaining(['is_personal', 'deletion_requested_at', 'control_plane_used_at'])
    )
    const constraints = await connection.client<Array<{ conname: string; definition: string }>>`
    SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid = 'app.workspaces'::regclass
  `
    expect(
      constraints.find((row) => row.conname === 'workspaces_personal_active')?.definition
    ).toContain('deletion_requested_at IS NULL')
    expect(
      constraints.find((row) => row.conname === 'workspaces_logo_valid')?.definition
    ).toContain('home')
    const indexes = await connection.client<Array<{ indexname: string; indexdef: string }>>`
    SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'app'
  `
    expect(
      indexes.find((row) => row.indexname === 'workspaces_personal_owner_unique')?.indexdef
    ).toContain('WHERE is_personal')
    expect(
      indexes.find((row) => row.indexname === 'task_submissions_ciphertext_expiry_idx')?.indexdef
    ).toContain('ciphertext_purged_at IS NULL')
    const retention = await connection.client<Array<{ definition: string }>>`
    SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid = 'app.task_submissions'::regclass AND conname = 'task_submissions_purge_after_expiry'
  `
    expect(retention[0]?.definition).toContain('expires_at')
    const receipts = await connection.client<Array<{ exists: boolean }>>`
    SELECT to_regclass('app.workspace_deletions') IS NOT NULL AS exists
  `
    expect(receipts[0]?.exists).toBe(true)
  }
)
