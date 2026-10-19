import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  assertProvisionedLoopback,
  fixtureEnvironment,
  memoryEnvironment,
  resolveLocalDockerEndpoint,
} from './policy.mjs'

const local = 'postgresql://postgres:synthetic@127.0.0.1:54399/postgres?sslmode=disable'
test('Docker provisioning rejects remote hosts, remote contexts and TLS overrides before mutation', () => {
  const socket = 'unix:///synthetic/docker.sock'
  const inspect = () => JSON.stringify(socket)
  assert.equal(resolveLocalDockerEndpoint({}, inspect), socket)
  assert.equal(resolveLocalDockerEndpoint({ DOCKER_HOST: socket }, inspect), socket)
  assert.equal(resolveLocalDockerEndpoint({ DOCKER_CONTEXT: 'local-context' }, inspect), socket)
  for (const endpoint of [
    'tcp://remote.example.test:2376',
    'ssh://operator@remote.example.test',
    'unix://remote/socket',
    'npipe:////remote/pipe/docker_engine',
  ]) {
    assert.throws(() => resolveLocalDockerEndpoint({ DOCKER_HOST: endpoint }, inspect))
    assert.throws(() =>
      resolveLocalDockerEndpoint({ DOCKER_CONTEXT: 'remote' }, () => JSON.stringify(endpoint))
    )
  }
  for (const key of ['DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) {
    assert.throws(() => resolveLocalDockerEndpoint({ [key]: 'synthetic' }, inspect))
  }
  assert.throws(() => resolveLocalDockerEndpoint({}, () => 'invalid metadata'))
})
test('accepts only the exact loopback provisioner URL shape', () => {
  assert.equal(assertProvisionedLoopback(local), local)
  for (const value of [
    local.replace('127.0.0.1', 'db.example.test'),
    local.replace('127.0.0.1:54399', 'localhost:54399'),
    local.replace('127.0.0.1:54399', '127.0.0.1'),
    local.replace('/postgres?', '/shared?'),
    local.replace('postgres:synthetic', 'runtime:synthetic'),
    local + '&host=db.example.test',
    local + '&options=-csearch_path=public',
    local + '#ignored',
    'postgresql:///postgres',
    'not a URL',
  ])
    assert.throws(() => assertProvisionedLoopback(value))
})
test('child environment excludes remote targets, PG routing and real delivery settings', () => {
  const env = fixtureEnvironment(local, {
    PATH: '/synthetic/bin',
    TMPDIR: '/tmp',
    LANG: 'C',
    DATABASE_URL: 'untrusted',
    DATABASE_MIGRATION_URL: 'untrusted',
    PGHOST: 'untrusted',
    PGSERVICE: 'untrusted',
    AUTH_DATABASE_URL: 'untrusted',
    AUTH_SECRET: 'untrusted',
    SMTP_PASSWORD: 'untrusted',
    ADEA_ALLOW_REMOTE_TEST_TARGET: 'untrusted',
    ADEA_CI_BRANCH_HOSTS: 'untrusted',
    MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL: 'untrusted',
  })
  assert.deepEqual(env, {
    PATH: '/synthetic/bin',
    TMPDIR: '/tmp',
    LANG: 'C',
    MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL: local,
  })
})

test('memory acceptance gets explicit opt-in and only the selected source plus process settings', () => {
  assert.deepEqual(
    memoryEnvironment('/synthetic/reviewed-source', {
      PATH: '/synthetic/bin',
      DATABASE_URL: 'untrusted',
      AUTH_SECRET: 'untrusted',
      FRESH_AUTH_SOURCE_ROOT: '/untrusted',
      FRESH_AUTH_ACCEPTANCE: '0',
      SMTP_PASSWORD: 'untrusted',
    }),
    {
      PATH: '/synthetic/bin',
      FRESH_AUTH_SOURCE_ROOT: '/synthetic/reviewed-source',
      FRESH_AUTH_ACCEPTANCE: '1',
    }
  )
})

test('explicit memory run fails closed before tests or provisioning when its source is absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'fresh-memory-preflight-'))
  try {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./run.mjs', import.meta.url)), '--repository', root, '--memory'],
      { encoding: 'utf8', env: { PATH: process.env.PATH } }
    )
    assert.equal(result.status, 1)
    assert.match(result.stderr, /memory acceptance prerequisite missing/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('missing source fails before the provisioner module can load', () => {
  const root = mkdtempSync(join(tmpdir(), 'fresh-schema-preflight-'))
  try {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./run.mjs', import.meta.url)), '--repository', root, '--preflight'],
      { encoding: 'utf8' }
    )
    assert.equal(result.status, 1)
    assert.match(
      result.stderr,
      /fresh-schema prerequisite missing: packages\/auth\/src\/better-auth-server.ts/
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test('complete preflight never imports provisioning or connects to a database', () => {
  const root = mkdtempSync(join(tmpdir(), 'fresh-schema-preflight-'))
  try {
    for (const path of [
      'packages/auth/src/better-auth-server.ts',
      'packages/auth/src/delivery.ts',
      'scripts/fresh-postgres-acceptance/auth-lifecycle.ts',
      'scripts/fresh-postgres-acceptance/fixture.ts',
    ]) {
      const file = join(root, path)
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, '// source-existence preflight fixture only\n')
    }
    writeFileSync(
      join(root, 'packages/auth/package.json'),
      JSON.stringify({
        dependencies: {
          'better-auth': '1.6.23',
          pg: '8.23.1',
        },
      })
    )
    writeFileSync(
      join(root, 'scripts/capture-provisioning.mjs'),
      "throw new Error('must not import provisioner in preflight')"
    )
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./run.mjs', import.meta.url)), '--repository', root, '--preflight'],
      { encoding: 'utf8' }
    )
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /no database started/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
