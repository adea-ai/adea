import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const runner = resolve(import.meta.dir, 'run-with-capture-provisioning.mjs')
// A PATH with no docker in it: the runner's Docker probe fails, so no instance is started. No
// container is created by these tests.
const withoutDocker = mkdtempSync(join(tmpdir(), 'no-docker-'))

describe('run-with-capture-provisioning', () => {
  test('without Docker the command runs unchanged: the migration and application URLs pass through and the capture variable stays unset', () => {
    const probe =
      "const e = process.env; process.exit(e.MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL !== undefined ? 3 : e.DATABASE_MIGRATION_URL === 'migration-role' && e.DATABASE_URL === 'application-role' ? 4 : 5)"
    const result = spawnSync(process.execPath, [runner, '--', process.execPath, '-e', probe], {
      encoding: 'utf8',
      env: {
        DATABASE_MIGRATION_URL: 'migration-role',
        DATABASE_URL: 'application-role',
        PATH: withoutDocker,
      },
    })
    expect(result.status).toBe(4)
    expect(result.stderr).toContain('Docker is unavailable')
  })

  test('the command exit status is the runner exit status', () => {
    const result = spawnSync(
      process.execPath,
      [runner, '--', process.execPath, '-e', 'process.exit(7)'],
      {
        encoding: 'utf8',
        env: { PATH: withoutDocker },
      }
    )
    expect(result.status).toBe(7)
  })

  test('refuses to run without a command after the separator', () => {
    const result = spawnSync(process.execPath, [runner], {
      encoding: 'utf8',
      env: { PATH: withoutDocker },
    })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('usage:')
  })
})
