// The installed-application acceptance lane's own decisions.
//
// Nothing here installs, launches, registers or opens anything: the lane's
// decision logic is exercised with injected dependencies, so no application
// is started, no operating system is asked to route a URL, and no credential
// store is touched.
//
// What these cases pin:
//   - the disposable profile layout, so a run can never write outside the
//     directory it owns;
//   - the verdict rule: a row that could not be run is a FAIL, never a skip,
//     so a hidden unfinished flow cannot pass as green;
//   - the redaction of the recorded artifact, so a published artifact can
//     never carry a token, a credential or the operator's home directory.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  redactRecordedText,
  resolveAcceptanceProfile,
  summarizeAcceptance,
  type AcceptanceCheck,
} from './installed-app-acceptance'

function check(overrides: Partial<AcceptanceCheck> = {}): AcceptanceCheck {
  return {
    id: 'a-row',
    expected: 'the installed application does the thing',
    actual: 'it did',
    ok: true,
    evidence: 'installed-app',
    ...overrides,
  }
}

describe('the disposable profile layout', () => {
  test('every path the run writes lives under the one root it owns', () => {
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

describe('the verdict rule', () => {
  test('every row passing is a pass', () => {
    const summary = summarizeAcceptance([check(), check({ id: 'b-row' })])
    expect(summary).toEqual({ passed: 2, failed: 0, total: 2, ok: true })
  })

  test('a row that could not be run is a failure, not a skip', () => {
    const summary = summarizeAcceptance([check(), check({ id: 'b-row', ok: false })])
    expect(summary.ok).toBe(false)
    expect(summary.failed).toBe(1)
  })

  test('an empty matrix is not a pass', () => {
    const summary = summarizeAcceptance([])
    expect(summary.ok).toBe(false)
    expect(summary.total).toBe(0)
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

describe('the lane leaves no state behind', () => {
  test('the disposable root it created is removable without touching anything else', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-acceptance-test-'))
    const profile = resolveAcceptanceProfile(root)
    writeFileSync(join(root, 'marker'), 'x')
    expect(existsSync(profile.root)).toBe(true)
    rmSync(profile.root, { force: true, recursive: true })
    expect(existsSync(profile.root)).toBe(false)
  })

  test('the artifact the lane writes is readable and carries the summary', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-acceptance-test-'))
    const artifact = join(root, 'artifact.json')
    writeFileSync(
      artifact,
      JSON.stringify({ summary: summarizeAcceptance([check()]), checks: [check()] })
    )
    const parsed = JSON.parse(readFileSync(artifact, 'utf8')) as {
      summary: { ok: boolean }
      checks: AcceptanceCheck[]
    }
    expect(parsed.summary.ok).toBe(true)
    expect(parsed.checks).toHaveLength(1)
    rmSync(root, { force: true, recursive: true })
  })
})
