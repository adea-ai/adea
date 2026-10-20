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
  createDisposableRoot,
  defaultArtifactPath,
  openAcceptanceLog,
  planApplicationSupportCleanup,
  redactRecordedText,
  removeOwnedRoot,
  resolveAcceptanceProfile,
  summarizeAcceptance,
  type AcceptanceCheck,
} from './installed-app-acceptance'

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
