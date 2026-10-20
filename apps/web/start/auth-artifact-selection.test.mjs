// Regression tests for which built auth output an acceptance run may accept. They use
// temporary directories and no build, so they run in the normal web test lane.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkMarkers, selectArtifact, workerVariables } from './auth-artifact-selection.mjs'

const PRODUCTION = '/repo/apps/web/dist'
const FIXTURE = '/repo/apps/web/start/.checks/auth-fixture/dist'

function select(args, env = {}, productionDir = PRODUCTION) {
  return selectArtifact({
    args,
    env,
    productionDir,
    defaultFixtureDir: FIXTURE,
  })
}

describe('selectArtifact', () => {
  test('the default run accepts the fixture output', () => {
    expect(select([])).toEqual({ kind: 'fixture', directory: FIXTURE, production: false })
  })

  test('the fixture run may point at another fixture output', () => {
    expect(select([], { ADEA_AUTH_FIXTURE_DIST: '/elsewhere/fixture' })).toEqual({
      kind: 'fixture',
      directory: '/elsewhere/fixture',
      production: false,
    })
  })

  test('--production accepts only the production output', () => {
    expect(select(['--production'])).toEqual({
      kind: 'production',
      directory: PRODUCTION,
      production: true,
    })
  })

  test('--production refuses a fixture directory override', () => {
    expect(() =>
      select(['--production'], { ADEA_AUTH_FIXTURE_DIST: '/elsewhere/fixture' })
    ).toThrow('unset ADEA_AUTH_FIXTURE_DIST')
  })

  test('the fixture run refuses the production output by its path', () => {
    expect(() => select([], { ADEA_AUTH_FIXTURE_DIST: PRODUCTION })).toThrow(
      'refusing to run the fixture acceptance against the production output'
    )
  })

  test('the fixture run refuses the production output with a trailing slash', () => {
    expect(() => select([], { ADEA_AUTH_FIXTURE_DIST: `${PRODUCTION}/` })).toThrow(
      'refusing to run the fixture acceptance'
    )
  })

  test('the fixture run refuses the production output through a symlink', () => {
    const base = mkdtempSync(join(tmpdir(), 'auth-artifact-'))
    const production = join(base, 'dist')
    const link = join(base, 'alias')
    mkdirSync(production)
    symlinkSync(production, link)
    expect(() => select([], { ADEA_AUTH_FIXTURE_DIST: link }, production)).toThrow(
      'refusing to run the fixture acceptance'
    )
  })

  test('an empty fixture directory override is refused', () => {
    expect(() => select([], { ADEA_AUTH_FIXTURE_DIST: '' })).toThrow('set but empty')
  })

  test('an unknown argument is refused', () => {
    expect(() => select(['--exercise'])).toThrow('unknown argument: --exercise')
  })
})

const WORKER_INPUT = {
  baseURL: 'https://127.0.0.1:9443',
  databaseUrl: 'postgresql://app@127.0.0.1:55433/agent_hq',
  secret: 'test-only-secret',
  outboxUrl: 'http://127.0.0.1:9900',
}

describe('workerVariables', () => {
  test('the production Worker runs with verification explicitly off and no fixture variable', () => {
    const vars = workerVariables({ kind: 'production', ...WORKER_INPUT })
    expect(vars.AUTH_EMAIL_VERIFICATION_REQUIRED).toBe('false')
    expect(vars).not.toHaveProperty('ADEA_AUTH_FIXTURE_OUTBOX_URL')
    expect(vars.AUTH_SECURE_COOKIES).toBe('true')
  })

  test('the fixture Worker requires verification and owns the outbox', () => {
    const vars = workerVariables({ kind: 'fixture', ...WORKER_INPUT })
    expect(vars.AUTH_EMAIL_VERIFICATION_REQUIRED).toBe('true')
    expect(vars.ADEA_AUTH_FIXTURE_OUTBOX_URL).toBe(WORKER_INPUT.outboxUrl)
  })

  test('the Worker never takes verification from an unknown artifact kind', () => {
    expect(() => workerVariables({ kind: 'staging', ...WORKER_INPUT })).toThrow(
      'unknown artifact kind'
    )
  })
})

describe('checkMarkers', () => {
  test('a production output with a fixture marker is refused', () => {
    expect(() =>
      checkMarkers({ kind: 'production', markerCount: 1, directory: PRODUCTION })
    ).toThrow('production output carries fixture markers')
  })

  test('a marker-free production output is accepted', () => {
    expect(() =>
      checkMarkers({ kind: 'production', markerCount: 0, directory: PRODUCTION })
    ).not.toThrow()
  })

  test('a fixture output without markers is refused', () => {
    expect(() => checkMarkers({ kind: 'fixture', markerCount: 0, directory: FIXTURE })).toThrow(
      'fixture output carries no fixture markers'
    )
  })

  test('a fixture output with markers is accepted', () => {
    expect(() =>
      checkMarkers({ kind: 'fixture', markerCount: 2, directory: FIXTURE })
    ).not.toThrow()
  })
})
