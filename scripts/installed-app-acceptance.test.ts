// The installed-application acceptance lane's own decisions.
//
// Nothing here installs, launches, registers or opens anything: every case
// exercises a PURE helper or a helper that touches only the temporary
// directory the case itself created. The lane's entry point and the
// application-launching path are deliberately NOT exercised here.
//
// What these cases pin:
//   - the run's directory is UNIQUELY created and carries an ownership
//     marker, and the teardown removes it only when the marker still matches;
//   - a caller-named path is never a removal target, and an unrelated
//     directory (a real profile, another tool's data) survives the teardown;
//   - exactly one application-support path is ever a removal candidate, and a
//     path that existed before the run is never removed;
//   - the artifact of a run lives outside the directory the teardown removes;
//   - the log has an explicit descriptor lifecycle, and a failed write is
//     counted rather than swallowed;
//   - a row that could not be verified is `pending`, and a pending row is
//     never a pass.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ACCEPTANCE_OWNER_MARKER,
  acceptanceRow,
  assessNativeProfileIsolation,
  assessSocketObservation,
  createDisposableRoot,
  defaultArtifactPath,
  inspectProviderEnvironment,
  launchDependentRows,
  openAcceptanceLog,
  planApplicationSupportCleanup,
  redactRecordedText,
  removeOwnedRoot,
  resolveAcceptanceProfile,
  runInstalledAppAcceptance,
  summarizeAcceptance,
  type AcceptanceCheck,
} from './installed-app-acceptance'
import { INSTALLED_APP_UI_ROW_IDS } from './installed-app-ui-rows'

function check(overrides: Partial<AcceptanceCheck> = {}): AcceptanceCheck {
  return acceptanceRow({
    id: 'a-row',
    expected: 'the installed application does the thing',
    actual: 'it did',
    status: 'pass',
    evidence: 'installed-app',
    ...overrides,
  })
}

describe('the disposable profile layout', () => {
  test('every path the run writes lives under the one directory it owns', () => {
    const profile = resolveAcceptanceProfile('/tmp/adea-acceptance-run')
    const root = '/tmp/adea-acceptance-run'
    for (const path of [profile.home, profile.data, profile.installRoot, profile.installedApp]) {
      expect(path.startsWith(root)).toBe(true)
    }
    expect(profile.installedApp.endsWith('/Applications/Adea-dev.app')).toBe(true)
  })

  test('the root is resolved, so a relative path cannot escape it', () => {
    const profile = resolveAcceptanceProfile('/tmp/adea-acceptance-run/../run')
    expect(profile.root).toBe('/tmp/run')
    expect(profile.data.startsWith('/tmp/run')).toBe(true)
  })
})

describe('the run owns a uniquely created directory', () => {
  test('two runs never share a directory', () => {
    const parent = mkdtempSync(join(tmpdir(), 'adea-acceptance-parent-'))
    const first = createDisposableRoot({ parent })
    const second = createDisposableRoot({ parent })
    expect(first.path).not.toBe(second.path)
    expect(existsSync(first.path)).toBe(true)
    expect(existsSync(second.path)).toBe(true)
    rmSync(parent, { force: true, recursive: true })
  })

  test('a caller-named path that already exists is left exactly as it was', () => {
    const parent = mkdtempSync(join(tmpdir(), 'adea-acceptance-parent-'))
    // A caller's path that holds real data, standing in for a real profile.
    const callerPath = join(parent, 'a-real-profile')
    mkdirSync(callerPath, { recursive: true })
    writeFileSync(join(callerPath, 'important.txt'), 'keep me')
    const root = createDisposableRoot({ parent })
    expect(root.path).not.toBe(callerPath)
    expect(existsSync(join(callerPath, 'important.txt'))).toBe(true)
    removeOwnedRoot(root)
    // The teardown removed the run's own directory and nothing else.
    expect(existsSync(root.path)).toBe(false)
    expect(existsSync(join(callerPath, 'important.txt'))).toBe(true)
    rmSync(parent, { force: true, recursive: true })
  })

  test('the directory carries an ownership marker with this run’s token', () => {
    const parent = mkdtempSync(join(tmpdir(), 'adea-acceptance-parent-'))
    const root = createDisposableRoot({ parent })
    expect(readFileSync(root.markerPath, 'utf8').trim()).toBe(root.token)
    expect(root.markerPath).toBe(join(root.path, ACCEPTANCE_OWNER_MARKER))
    rmSync(parent, { force: true, recursive: true })
  })
})

describe('the teardown removes only what this run created', () => {
  test('an unrelated directory with no marker survives', () => {
    const parent = mkdtempSync(join(tmpdir(), 'adea-acceptance-parent-'))
    const unrelated = join(parent, 'someone-elses-data')
    mkdirSync(unrelated, { recursive: true })
    writeFileSync(join(unrelated, 'data.bin'), 'not ours')
    const removal = removeOwnedRoot({
      path: unrelated,
      token: 'a-token-that-does-not-own-this',
      markerPath: join(unrelated, ACCEPTANCE_OWNER_MARKER),
      parent,
    })
    expect(removal.removed).toBe(false)
    expect(removal.reason).toContain('ownership marker')
    expect(existsSync(join(unrelated, 'data.bin'))).toBe(true)
    rmSync(parent, { force: true, recursive: true })
  })

  test('a directory carrying another run’s marker survives', () => {
    const parent = mkdtempSync(join(tmpdir(), 'adea-acceptance-parent-'))
    const root = createDisposableRoot({ parent })
    const other = createDisposableRoot({ parent })
    const removal = removeOwnedRoot({
      path: other.path,
      token: root.token,
      markerPath: other.markerPath,
      parent,
    })
    expect(removal.removed).toBe(false)
    expect(existsSync(other.path)).toBe(true)
    rmSync(parent, { force: true, recursive: true })
  })

  test('the parent itself is never removed', () => {
    const parent = mkdtempSync(join(tmpdir(), 'adea-acceptance-parent-'))
    const removal = removeOwnedRoot({
      path: parent,
      token: 'token',
      markerPath: join(parent, ACCEPTANCE_OWNER_MARKER),
      parent,
    })
    expect(removal.removed).toBe(false)
    expect(existsSync(parent)).toBe(true)
    rmSync(parent, { force: true, recursive: true })
  })

  test('the run’s own directory is removed', () => {
    const parent = mkdtempSync(join(tmpdir(), 'adea-acceptance-parent-'))
    const root = createDisposableRoot({ parent })
    const removal = removeOwnedRoot(root)
    expect(removal.removed).toBe(true)
    expect(existsSync(root.path)).toBe(false)
    rmSync(parent, { force: true, recursive: true })
  })
})

describe('the evidence of a run outlives the run', () => {
  test('the artifact path is outside the directory the teardown removes', () => {
    const parent = mkdtempSync(join(tmpdir(), 'adea-acceptance-parent-'))
    const root = createDisposableRoot({ parent })
    const artifact = defaultArtifactPath(root)
    expect(artifact.startsWith(root.path + '/')).toBe(false)
    expect(artifact.startsWith(parent + '/')).toBe(true)
    writeFileSync(artifact, '{"summary":{}}\n')
    removeOwnedRoot(root)
    // The artifact is still there after the run's directory is gone.
    expect(existsSync(artifact)).toBe(true)
    rmSync(parent, { force: true, recursive: true })
  })
})

describe('the application-support cleanup decides on exactly one path', () => {
  const parent = '/Users/operator/Library/Application Support/dev.adea.desktop'
  const owned = `${parent}/dev`

  test('a path that existed before the run is never removed', () => {
    const decision = planApplicationSupportCleanup({
      path: owned,
      existedBefore: true,
      expectedParent: parent,
    })
    expect(decision.remove).toBe(false)
    expect(decision.reason).toContain('existed before')
  })

  test('a path outside the application identity directory is never removed', () => {
    const decision = planApplicationSupportCleanup({
      path: '/Users/operator/Library/Application Support/another.app/dev',
      existedBefore: false,
      expectedParent: parent,
    })
    expect(decision.remove).toBe(false)
    expect(decision.reason).toContain('outside')
  })

  test('the exact path the run created is removable', () => {
    const decision = planApplicationSupportCleanup({
      path: owned,
      existedBefore: false,
      expectedParent: parent,
    })
    expect(decision.remove).toBe(true)
  })
})

describe('the log has an explicit descriptor lifecycle', () => {
  test('a write lands in the file and the descriptor closes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'adea-acceptance-log-'))
    const path = join(directory, 'app.log')
    const log = openAcceptanceLog(path)
    expect(log.write(Buffer.from('first line\n'))).toBe(true)
    expect(log.failures()).toBe(0)
    log.close()
    // Writing after the close fails, and the failure is counted rather than
    // swallowed.
    expect(log.write(Buffer.from('too late\n'))).toBe(false)
    expect(log.failures()).toBe(1)
    expect(readFileSync(path, 'utf8')).toBe('first line\n')
    rmSync(directory, { force: true, recursive: true })
  })
})

describe('the verdict rule', () => {
  test('every row passing is a pass', () => {
    const summary = summarizeAcceptance([check(), check({ id: 'b-row' })])
    expect(summary).toEqual({ passed: 2, failed: 0, pending: 0, total: 2, ok: true })
  })

  test('a row that failed is a failure', () => {
    const summary = summarizeAcceptance([check(), check({ id: 'b-row', status: 'fail' })])
    expect(summary.ok).toBe(false)
    expect(summary.failed).toBe(1)
  })

  test('a row that could not be verified is pending, and never a pass', () => {
    const summary = summarizeAcceptance([check(), check({ id: 'b-row', status: 'pending' })])
    expect(summary.ok).toBe(false)
    expect(summary.pending).toBe(1)
    expect(summary.passed).toBe(1)
  })

  test('an empty matrix is not a pass', () => {
    const summary = summarizeAcceptance([])
    expect(summary.ok).toBe(false)
    expect(summary.total).toBe(0)
  })

  test('a row’s ok follows its status', () => {
    expect(acceptanceRow({ status: 'pass' }).ok).toBe(true)
    expect(acceptanceRow({ status: 'pending' }).ok).toBe(false)
    expect(acceptanceRow({ status: 'fail' }).ok).toBe(false)
  })
})

describe('the recorded artifact is redacted', () => {
  test("the operator's home directory never appears", () => {
    const text = redactRecordedText(
      '/Users/amf/Library/Application Support/dev.adea.desktop',
      '/Users/amf'
    )
    expect(text).not.toContain('/Users/amf')
    expect(text).toContain('~/Library')
  })

  test('a guest credential never appears', () => {
    const text = redactRecordedText('credential adea_tmp_abcdefghijklmnop')
    expect(text).not.toContain('adea_tmp_abcdefghijklmnop')
    expect(text).toContain('adea_tmp_<redacted>')
  })

  test('a token never appears', () => {
    const text = redactRecordedText('token: abcdef0123456789abcdef')
    expect(text).not.toContain('abcdef0123456789abcdef')
  })

  test('a temporary path never appears', () => {
    const text = redactRecordedText('wrote /private/tmp/adea-acceptance-1234/file.json')
    expect(text).not.toContain('adea-acceptance-1234')
  })
})

describe('the lane may not launch into the real user profile', () => {
  const realRoot = '/Users/operator/Library/Application Support/dev.adea.desktop'

  test('a native profile inside the real root is not isolated, and the missing contract is named', () => {
    const isolation = assessNativeProfileIsolation({
      profilePath: `${realRoot}/dev/CEF`,
      realRoot,
    })
    expect(isolation.isolated).toBe(false)
    expect(isolation.missing).toContain('per-run native profile root')
  })

  test('the absence of the path before a run proves nothing about ownership', () => {
    // The path not existing is exactly the situation the reviewer called out:
    // a real installation can create or use it concurrently.
    const decision = planApplicationSupportCleanup({
      path: `${realRoot}/dev`,
      existedBefore: false,
      expectedParent: realRoot,
    })
    // The lane no longer acts on this decision at all; the case documents that
    // the decision alone is not a licence to write there.
    expect(decision.remove).toBe(true)
    const isolation = assessNativeProfileIsolation({
      profilePath: `${realRoot}/dev`,
      realRoot,
    })
    expect(isolation.isolated).toBe(false)
  })

  test('a native profile outside the real root is isolated', () => {
    const isolation = assessNativeProfileIsolation({
      profilePath: '/private/tmp/adea-acceptance-run/native-profile',
      realRoot,
      isolationRoute: 'per-run-native-root',
    })
    expect(isolation.isolated).toBe(true)
    expect(isolation.missing).toBeNull()
  })

  test('a profile that appears concurrently is never removed', () => {
    // A real installation creates its profile while the lane is running.
    const parent = mkdtempSync(join(tmpdir(), 'adea-acceptance-parent-'))
    const realProfile = join(parent, 'dev.adea.desktop', 'dev')
    mkdirSync(realProfile, { recursive: true })
    writeFileSync(join(realProfile, 'state.bin'), 'the real app data')
    const root = createDisposableRoot({ parent })
    // The lane's teardown removes its own directory and nothing else.
    removeOwnedRoot(root)
    expect(existsSync(join(realProfile, 'state.bin'))).toBe(true)
    rmSync(parent, { force: true, recursive: true })
  })

  test('the lane does not launch, and every launch-dependent row is pending', async () => {
    let launched = false
    const run = await runInstalledAppAcceptance({
      bundle: '/nonexistent/Adea-dev.app',
      profile: resolveAcceptanceProfile('/tmp/adea-acceptance-never-launched'),
      isolation: assessNativeProfileIsolation({
        profilePath: `${realRoot}/dev/CEF`,
        realRoot,
      }),
      launch: () => {
        launched = true
        throw new Error('the lane must not launch without a proved isolation route')
      },
      fetchFromApp: async () => ({ status: 0, body: '' }),
    })
    expect(launched).toBe(false)
    const launchDependent = run.checks.filter((row) => row.id !== 'installed-bundle-identity')
    expect(launchDependent.length).toBeGreaterThan(0)
    expect(launchDependent.every((row) => row.status === 'pending')).toBe(true)
    expect(launchDependent.every((row) => !row.ok)).toBe(true)
    expect(run.artifact.launched).toBe(false)
    const isolation = run.artifact.isolation as { isolated: boolean; missing: string | null }
    expect(isolation.isolated).toBe(false)
    expect(isolation.missing).toContain('per-run native profile root')
  })

  test('the pending rows cover every launch-dependent and UI row', () => {
    const rows = launchDependentRows('the isolation contract is missing')
    expect(rows.every((row) => row.status === 'pending')).toBe(true)
    expect(rows.some((row) => row.id === 'the-installed-bridge-is-served')).toBe(true)
    for (const id of INSTALLED_APP_UI_ROW_IDS) {
      expect(rows.some((row) => row.id === id)).toBe(true)
    }
  })
})

describe('an unproved observation cannot pass', () => {
  test('an empty socket discovery is pending, not a pass', () => {
    const observation = assessSocketObservation([])
    expect(observation.status).toBe('pending')
    expect(observation.actual).toContain('not observed')
  })

  test('loopback peers are a pass and an off-loopback peer is a failure', () => {
    expect(assessSocketObservation(['127.0.0.1:4789', '[::1]:4789']).status).toBe('pass')
    expect(assessSocketObservation(['127.0.0.1:4789', '93.184.216.34:443']).status).toBe('fail')
  })

  test('a pending observation keeps the run red', () => {
    const summary = summarizeAcceptance([
      check(),
      acceptanceRow({
        id: 'unproved',
        expected: 'the traffic is observed',
        actual: 'no peer was seen',
        status: 'pending',
        evidence: 'installed-app',
      }),
    ])
    expect(summary.ok).toBe(false)
  })
})

describe('the provider proof looks at identifiers and at values', () => {
  test('a Neon identifier in a variable name is detected', () => {
    const finding = inspectProviderEnvironment({ NEON_AUTH_BASE_URL: 'https://example.test/auth' })
    expect(finding.neonIdentifiers).toContain('NEON_AUTH_BASE_URL')
    expect(finding.clean).toBe(false)
  })

  test('a Neon host in a value is detected even when the name says nothing', () => {
    const finding = inspectProviderEnvironment({
      DATABASE_URL: 'postgresql://user:password@ep-cool-name.neon.tech/adea?sslmode=require',
    })
    expect(finding.neonIdentifiers).toEqual([])
    expect(finding.neonHostVariables).toContain('DATABASE_URL')
    expect(finding.clean).toBe(false)
  })

  test('the two observations are independent', () => {
    const byName = inspectProviderEnvironment({ NEON_AUTH_COOKIE_SECRET: 'not-a-host' })
    expect(byName.neonIdentifiers).toHaveLength(1)
    expect(byName.neonHostVariables).toHaveLength(0)
    const byValue = inspectProviderEnvironment({ SOME_URL: 'https://db.example.neon.build/adea' })
    expect(byValue.neonIdentifiers).toHaveLength(0)
    expect(byValue.neonHostVariables).toHaveLength(1)
  })

  test('no secret value is ever reported', () => {
    const secret = 'super-secret-value-123456'
    const finding = inspectProviderEnvironment({
      DATABASE_URL: `postgresql://user:${secret}@db.example.neon.tech/adea`,
    })
    expect(JSON.stringify(finding)).not.toContain(secret)
    expect(finding.neonHostVariables).toEqual(['DATABASE_URL'])
  })

  test('an environment with no Neon endpoint is clean', () => {
    const finding = inspectProviderEnvironment({
      DATABASE_URL: 'postgresql://user:password@127.0.0.1:55500/adea',
      PATH: '/usr/bin',
    })
    expect(finding.clean).toBe(true)
  })
})
