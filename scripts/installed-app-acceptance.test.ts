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
  assessLogCompleteness,
  assessNativeProfileIsolation,
  assessSocketObservation,
  SUPPORTED_ISOLATION_CONTRACTS,
  createDisposableRoot,
  createFinalizingStop,
  createLogFailureLedger,
  defaultArtifactPath,
  drainOutputStreams,
  finalizeAndAssessLaunches,
  inspectProviderEnvironment,
  launchDependentRows,
  openAcceptanceLog,
  planApplicationSupportCleanup,
  redactRecordedText,
  removeOwnedRoot,
  resolveAcceptanceProfile,
  runInstalledAppAcceptance,
  type OutputStreamProbe,
  type ProcessExitProbe,
  type RunningApp,
  waitForProcessExit,
  runInstalledAppPreflight,
  summarizeAcceptance,
  type AcceptanceCheck,
} from './installed-app-acceptance'
import {
  assessFolderCommandExposure,
  assessInterruptedNavigation,
  FOLDER_PICK_COMMAND,
  INSTALLED_APP_UI_ROW_IDS,
} from './installed-app-ui-rows'

/** A process that never exits. */
function stuckProcess(): ProcessExitProbe {
  return {
    exitCode: null,
    signalCode: null,
    once: () => undefined,
    off: () => undefined,
  }
}

/** A process that exits shortly after it is waited for. */
function exitingProcess(): ProcessExitProbe {
  return {
    exitCode: null,
    signalCode: null,
    once: (event, listener) => {
      if (event === 'exit') setTimeout(listener, 1)
    },
    off: () => undefined,
  }
}

/** An output stream that never ends. */
function stuckStream(): OutputStreamProbe {
  return {
    once: () => undefined,
    removeListener: () => undefined,
  }
}

/** An output stream that ends shortly after it is waited for. */
function endingStream(): OutputStreamProbe {
  return {
    once: (event, listener) => {
      if (event === 'end') setTimeout(listener, 1)
    },
    removeListener: () => undefined,
  }
}

/** An output stream that has already ended. */
function alreadyEndedStream(): OutputStreamProbe {
  return {
    readableEnded: true,
    destroyed: true,
    once: () => undefined,
    removeListener: () => undefined,
  }
}

/** An output stream that was destroyed before it ended. */
function destroyedBeforeEndStream(): OutputStreamProbe {
  return {
    readableEnded: false,
    destroyed: true,
    once: () => undefined,
    removeListener: () => undefined,
  }
}

/** An output stream that closes before it ends. */
function closingBeforeEndStream(): OutputStreamProbe {
  return {
    readableEnded: false,
    destroyed: false,
    once: (event, listener) => {
      if (event === 'close') setTimeout(listener, 1)
    },
    removeListener: () => undefined,
  }
}

/** An output stream that fails while it is drained. */
function failingStream(): OutputStreamProbe {
  return {
    readableEnded: false,
    destroyed: false,
    once: (event, listener) => {
      if (event === 'error') setTimeout(listener, 1)
    },
    removeListener: () => undefined,
  }
}

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
    expect(isolation.missing).toContain('supported native profile isolation contract')
  })

  test('a descriptive label is not evidence and is refused', () => {
    for (const id of ['per-run-native-root', 'unique-identity', 'none', 'adea-acceptance']) {
      const isolation = assessNativeProfileIsolation({
        profilePath: `${realRoot}/dev/CEF`,
        realRoot,
        claimed: { id, environment: {} },
      })
      expect(isolation.isolated).toBe(false)
      expect(isolation.missing).toContain('not a supported native profile isolation contract')
    }
  })

  test('an outside path without a validated route is not evidence either', () => {
    const isolation = assessNativeProfileIsolation({
      profilePath: '/private/tmp/adea-acceptance-run/native-profile',
      realRoot,
    })
    expect(isolation.isolated).toBe(false)
    expect(isolation.missing).toContain('supported native profile isolation contract')
  })

  test('the supported contract registry is empty, so nothing can be honoured yet', () => {
    expect(SUPPORTED_ISOLATION_CONTRACTS).toEqual([])
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

  test('a supported contract that is not in force does not isolate the run', () => {
    // The registry is empty, so every claim is refused: even an outside path
    // with a plausible label.
    const isolation = assessNativeProfileIsolation({
      profilePath: '/private/tmp/adea-acceptance-run/native-profile',
      realRoot,
      claimed: { id: 'per-run-native-root', environment: {} },
    })
    expect(isolation.isolated).toBe(false)
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
      isolationEvidence: {
        profilePath: `${realRoot}/dev/CEF`,
        realRoot,
      },
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
    expect(isolation.missing).toContain('supported native profile isolation contract')
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

describe("the lane's own row log is not a test runner's verdict", () => {
  const realRoot = '/Users/operator/Library/Application Support/dev.adea.desktop'

  test('no row line can be read as a failing test', async () => {
    // The lane prints one line per row while it runs, and the lane's own
    // tests run the lane. A line that opens with the bare token `FAIL` is
    // read as a failing test by every CI log scanner, so the row log must
    // never look like a verdict.
    const printed: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => {
      printed.push(args.map((value) => String(value)).join(' '))
    }
    try {
      const run = await runInstalledAppAcceptance({
        bundle: '/nonexistent/Adea-dev.app',
        profile: resolveAcceptanceProfile('/tmp/adea-acceptance-row-log'),
        isolationEvidence: {
          profilePath: `${realRoot}/dev/CEF`,
          realRoot,
        },
        launch: () => {
          throw new Error('the lane must not launch without a proved isolation route')
        },
        fetchFromApp: async () => ({ status: 0, body: '' }),
      })
      const rowIds = run.checks.map((row) => row.id)
      expect(printed.length).toBeGreaterThan(0)
      for (const line of printed) {
        // Neither the shape a Jest/Vitest reporter prints nor the shape Bun
        // prints may appear: these are the lane's own rows, not a verdict.
        expect(/^\s*FAIL\b/.test(line)).toBe(false)
        expect(line.startsWith('(fail)')).toBe(false)
        // A line that names one of the run's rows is one of the lane's own
        // namespaced row lines.
        if (rowIds.some((id) => line.includes(id))) {
          expect(line.startsWith('installed-app acceptance: row ')).toBe(true)
        }
      }
      // The log is not silenced: the failing row and the pending rows are
      // still reported, under the lane's own namespace.
      expect(
        printed.some(
          (line) => line.includes('row fail') && line.includes('installed-bundle-identity')
        )
      ).toBe(true)
      expect(printed.some((line) => line.includes('row pending'))).toBe(true)
    } finally {
      console.log = original
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

describe("the run's log failures are aggregated and they count", () => {
  test('a write that arrives after the descriptor closed is counted', () => {
    const directory = mkdtempSync(join(tmpdir(), 'adea-acceptance-log-'))
    const ledger = createLogFailureLedger()
    const log = openAcceptanceLog(join(directory, 'app.log'), ledger)
    log.close()
    expect(log.write(Buffer.from('too late\n'))).toBe(false)
    expect(ledger.count()).toBe(1)
    rmSync(directory, { force: true, recursive: true })
  })

  test('the failures of every launch are counted together', () => {
    const directory = mkdtempSync(join(tmpdir(), 'adea-acceptance-log-'))
    const ledger = createLogFailureLedger()
    const first = openAcceptanceLog(join(directory, 'first.log'), ledger)
    const second = openAcceptanceLog(join(directory, 'second.log'), ledger)
    first.close()
    second.close()
    expect(first.write(Buffer.from('a\n'))).toBe(false)
    expect(second.write(Buffer.from('b\n'))).toBe(false)
    expect(ledger.count()).toBe(2)
    rmSync(directory, { force: true, recursive: true })
  })

  test("the first launch's failure is not discarded when a second launch follows", () => {
    const directory = mkdtempSync(join(tmpdir(), 'adea-acceptance-log-'))
    const ledger = createLogFailureLedger()
    const first = openAcceptanceLog(join(directory, 'first.log'), ledger)
    first.close()
    expect(first.write(Buffer.from('a\n'))).toBe(false)
    // The second launch opens its own descriptor and its own file; the first
    // launch's failure is still in the ledger.
    const second = openAcceptanceLog(join(directory, 'second.log'), ledger)
    expect(second.path).not.toBe(first.path)
    expect(ledger.count()).toBe(1)
    rmSync(directory, { force: true, recursive: true })
  })

  test('any failure makes the logging row a failure, and the run red', () => {
    expect(assessLogCompleteness(0, 2).status).toBe('pass')
    expect(assessLogCompleteness(1, 2).status).toBe('fail')
    expect(assessLogCompleteness(1, 2).actual).toContain('1 log write failure')
    const summary = summarizeAcceptance([
      check(),
      acceptanceRow({
        id: 'the-run-log-recorded-everything',
        expected: 'every launch wrote its output',
        actual: '1 log write failure',
        status: 'fail',
        evidence: 'installed-app',
      }),
    ])
    expect(summary.ok).toBe(false)
  })
})

describe('the interruption row claims only what it observed', () => {
  const dev = '{"headings":["Dev"]}'
  const chat = '{"headings":["Chat"]}'

  test('overlapping requests that settle on the second destination pass', () => {
    expect(
      assessInterruptedNavigation({
        issuedOverlapping: true,
        settledSignature: dev,
        devSignature: dev,
        chatSignature: chat,
      }).status
    ).toBe('pass')
  })

  test('requests that were NOT overlapping cannot pass the interruption row', () => {
    const verdict = assessInterruptedNavigation({
      issuedOverlapping: false,
      settledSignature: dev,
      devSignature: dev,
      chatSignature: chat,
    })
    expect(verdict.status).toBe('pending')
    expect(verdict.actual).toContain('not dispatched concurrently')
  })

  test('overlapping requests that settle on the wrong view fail', () => {
    expect(
      assessInterruptedNavigation({
        issuedOverlapping: true,
        settledSignature: chat,
        devSignature: dev,
        chatSignature: chat,
      }).status
    ).toBe('fail')
  })

  test('destinations that render the same content cannot be told apart', () => {
    expect(
      assessInterruptedNavigation({
        issuedOverlapping: true,
        settledSignature: dev,
        devSignature: dev,
        chatSignature: dev,
      }).status
    ).toBe('pending')
  })
})

describe('the folder-pick row needs the exact command identity', () => {
  test('the exact command proves the row', () => {
    expect(
      assessFolderCommandExposure({ hasInvoke: true, commands: [FOLDER_PICK_COMMAND] }).status
    ).toBe('pass')
  })

  test('a command that merely contains folder or pick does not prove it', () => {
    for (const name of [
      'desktop_folder_pick_extra',
      'pick_folder',
      'folder',
      'pickDesktopFolder',
    ]) {
      const verdict = assessFolderCommandExposure({ hasInvoke: true, commands: [name] })
      expect(verdict.status).not.toBe('pass')
      expect(verdict.status).toBe('fail')
    }
  })

  test('a surface with no command list cannot prove it', () => {
    expect(assessFolderCommandExposure({ hasInvoke: true, commands: [] }).status).toBe('pending')
  })

  test('a surface with no invoke at all fails', () => {
    expect(assessFolderCommandExposure({ hasInvoke: false, commands: [] }).status).toBe('fail')
  })
})

describe('the preflight has no side effects', () => {
  const realRoot = '/Users/operator/Library/Application Support/dev.adea.desktop'

  test('no install, registration or launch happens when the proof is missing', async () => {
    const recorded: string[] = []
    const parent = mkdtempSync(join(tmpdir(), 'adea-acceptance-parent-'))
    const preflight = await runInstalledAppPreflight({
      bundle: join(parent, 'Adea-dev.app'),
      evidence: {
        profilePath: `${realRoot}/dev/CEF`,
        realRoot,
      },
      sideEffects: { record: (event) => recorded.push(event) },
    })
    // Nothing was installed, registered, launched or profiled.
    expect(recorded).toEqual([])
    expect(preflight.artifact.installed).toBe(false)
    expect(preflight.artifact.registered).toBe(false)
    expect(preflight.artifact.launched).toBe(false)
    expect(preflight.artifact.sideEffects).toEqual([])
    // No install root was created for the application.
    expect(existsSync(join(parent, 'Applications'))).toBe(false)
    rmSync(parent, { force: true, recursive: true })
  })

  test('the preflight records the truthful pending evidence', async () => {
    const preflight = await runInstalledAppPreflight({
      bundle: '/nonexistent/Adea-dev.app',
      evidence: {
        profilePath: `${realRoot}/dev/CEF`,
        realRoot,
      },
    })
    const launchDependent = preflight.checks.filter((row) => row.id !== 'installed-bundle-identity')
    expect(launchDependent.length).toBeGreaterThan(0)
    expect(launchDependent.every((row) => row.status === 'pending')).toBe(true)
    expect(launchDependent.every((row) => !row.ok)).toBe(true)
    const isolation = preflight.artifact.isolation as { isolated: boolean; missing: string | null }
    expect(isolation.isolated).toBe(false)
    expect(isolation.missing).toContain('supported native profile isolation contract')
    const summary = preflight.artifact.summary as { ok: boolean }
    expect(summary.ok).toBe(false)
  })

  test('a claimed label does not make the preflight launch anything', async () => {
    const recorded: string[] = []
    const preflight = await runInstalledAppPreflight({
      bundle: '/nonexistent/Adea-dev.app',
      evidence: {
        profilePath: '/private/tmp/adea-acceptance-run/native-profile',
        realRoot,
        claimed: { id: 'unique-identity', environment: {} },
      },
      sideEffects: { record: (event) => recorded.push(event) },
    })
    expect(recorded).toEqual([])
    expect(preflight.artifact.launched).toBe(false)
    const isolation = preflight.artifact.isolation as { isolated: boolean }
    expect(isolation.isolated).toBe(false)
  })
})

describe('every launch is finalized before the verdict is taken', () => {
  test('a failure injected during stop and trailing output reaches the verdict', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'adea-acceptance-log-'))
    const ledger = createLogFailureLedger()
    const first = openAcceptanceLog(join(directory, 'first.log'), ledger)
    const second = openAcceptanceLog(join(directory, 'second.log'), ledger)
    const stops: string[] = []
    const launches: RunningApp[] = [
      {
        pid: 1,
        logPath: first.path,
        logWriteFailures: () => ledger.count(),
        stop: async () => {
          stops.push('first')
          // The process's trailing output arrives as it goes down.
          first.write(Buffer.from('trailing output\n'))
          first.close()
          // And one more byte arrives after the descriptor closed.
          first.write(Buffer.from('after close\n'))
        },
      },
      {
        pid: 2,
        logPath: second.path,
        logWriteFailures: () => ledger.count(),
        stop: async () => {
          stops.push('second')
          second.close()
        },
      },
    ]
    const result = await finalizeAndAssessLaunches(launches, ledger)
    // Every launch was finalized, in order.
    expect(stops).toEqual(['first', 'second'])
    // The trailing failure of the FIRST launch is counted, not discarded.
    expect(result.failures).toBe(1)
    expect(result.completeness.status).toBe('fail')
    expect(result.completeness.actual).toContain('1 log write failure')
    // And the run's verdict is red.
    const summary = summarizeAcceptance([
      check(),
      acceptanceRow({
        id: 'the-run-log-recorded-everything',
        expected: 'every launch wrote its output',
        actual: result.completeness.actual,
        status: result.completeness.status,
        evidence: 'installed-app',
      }),
    ])
    expect(summary.ok).toBe(false)
    rmSync(directory, { force: true, recursive: true })
  })

  test('the ledger is snapshotted only after every stop has resolved', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'adea-acceptance-log-'))
    const ledger = createLogFailureLedger()
    const log = openAcceptanceLog(join(directory, 'app.log'), ledger)
    let settled = false
    const launches: RunningApp[] = [
      {
        pid: 1,
        logPath: log.path,
        logWriteFailures: () => ledger.count(),
        stop: async () => {
          // The failure is injected AFTER an await: a verdict taken before the
          // stop resolved would miss it.
          await Promise.resolve()
          log.close()
          log.write(Buffer.from('late\n'))
          settled = true
        },
      },
    ]
    const result = await finalizeAndAssessLaunches(launches, ledger)
    expect(settled).toBe(true)
    expect(result.failures).toBe(1)
    expect(result.completeness.status).toBe('fail')
    rmSync(directory, { force: true, recursive: true })
  })

  test('a stop that throws is recorded as a failure of the evidence', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'adea-acceptance-log-'))
    const ledger = createLogFailureLedger()
    const launches: RunningApp[] = [
      {
        pid: 1,
        logPath: join(directory, 'app.log'),
        logWriteFailures: () => ledger.count(),
        stop: async () => {
          throw new Error('the launch could not be stopped cleanly')
        },
      },
    ]
    const result = await finalizeAndAssessLaunches(launches, ledger)
    expect(result.failures).toBe(1)
    expect(result.completeness.status).toBe('fail')
    rmSync(directory, { force: true, recursive: true })
  })

  test('a clean finalization of every launch is a pass', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'adea-acceptance-log-'))
    const ledger = createLogFailureLedger()
    const first = openAcceptanceLog(join(directory, 'first.log'), ledger)
    const second = openAcceptanceLog(join(directory, 'second.log'), ledger)
    const launches: RunningApp[] = [
      {
        pid: 1,
        logPath: first.path,
        logWriteFailures: () => ledger.count(),
        stop: async () => {
          first.write(Buffer.from('output\n'))
          first.close()
        },
      },
      {
        pid: 2,
        logPath: second.path,
        logWriteFailures: () => ledger.count(),
        stop: async () => {
          second.close()
        },
      },
    ]
    const result = await finalizeAndAssessLaunches(launches, ledger)
    expect(result.failures).toBe(0)
    expect(result.completeness.status).toBe('pass')
    expect(result.completeness.actual).toContain('2 launch(es)')
    rmSync(directory, { force: true, recursive: true })
  })
})

describe('the teardown helpers report a timeout as a failure', () => {
  test('a process that does not exit within the bound is a failed wait', async () => {
    const outcome = await waitForProcessExit(stuckProcess(), 25)
    expect(outcome.completed).toBe(false)
    expect(outcome.problems).toHaveLength(1)
    expect(outcome.problems[0]).toContain('did not exit within 25ms')
  })

  test('a process that exits is a completed wait', async () => {
    const outcome = await waitForProcessExit(exitingProcess(), 1_000)
    expect(outcome.completed).toBe(true)
    expect(outcome.problems).toEqual([])
  })

  test('a process that already exited is a completed wait', async () => {
    const outcome = await waitForProcessExit(
      { exitCode: 0, signalCode: null, once: () => undefined, off: () => undefined },
      25
    )
    expect(outcome.completed).toBe(true)
  })

  test('a stream that does not end within the bound is a failed drain', async () => {
    const outcome = await drainOutputStreams([stuckStream(), stuckStream()], 25)
    expect(outcome.completed).toBe(false)
    expect(outcome.problems).toHaveLength(2)
    expect(outcome.problems[0]).toContain('did not end within 25ms')
  })

  test('streams that end are a completed drain', async () => {
    const outcome = await drainOutputStreams([endingStream(), null], 1_000)
    expect(outcome.completed).toBe(true)
    expect(outcome.problems).toEqual([])
  })

  test('a stuck process and a stuck stream are recorded before the verdict', async () => {
    const ledger = createLogFailureLedger()
    const stopper = createFinalizingStop({
      signal: () => {},
      exit: stuckProcess(),
      streams: [stuckStream()],
      close: () => {},
      ledger,
      bounds: { exit: 25, drain: 25 },
    })
    await stopper.stop()
    expect(stopper.problems()).toHaveLength(2)
    expect(ledger.count()).toBe(2)
    const result = await finalizeAndAssessLaunches(
      [
        {
          pid: 1,
          logPath: '/nonexistent/app.log',
          logWriteFailures: () => ledger.count(),
          stop: () => stopper.stop(),
        },
      ],
      ledger
    )
    expect(result.failures).toBe(2)
    expect(result.completeness.status).toBe('fail')
    expect(result.completeness.actual).toContain('2 log write failure')
  })

  test('repeated and concurrent stop callers await the same finalization', async () => {
    const ledger = createLogFailureLedger()
    let closed = 0
    const stopper = createFinalizingStop({
      signal: () => {},
      exit: stuckProcess(),
      streams: [stuckStream()],
      close: () => {
        closed += 1
      },
      ledger,
      bounds: { exit: 25, drain: 25 },
    })
    const first = stopper.stop()
    const second = stopper.stop()
    // The same in-flight promise: one finalization, one descriptor close.
    expect(first).toBe(second)
    await Promise.all([first, second])
    await stopper.stop()
    expect(closed).toBe(1)
    // The teardown problems were recorded once, not once per caller.
    expect(stopper.problems()).toHaveLength(2)
    expect(ledger.count()).toBe(2)
  })

  test('a clean teardown of a process that exited and streams that ended records nothing', async () => {
    const ledger = createLogFailureLedger()
    const stopper = createFinalizingStop({
      signal: () => {},
      exit: exitingProcess(),
      streams: [endingStream()],
      close: () => {},
      ledger,
      bounds: { exit: 1_000, drain: 1_000 },
    })
    await stopper.stop()
    expect(stopper.problems()).toEqual([])
    expect(ledger.count()).toBe(0)
  })
})

describe('only a confirmed readable end is a successful drain', () => {
  test('a stream that has already ended is drained', async () => {
    const outcome = await drainOutputStreams([alreadyEndedStream()], 25)
    expect(outcome.completed).toBe(true)
    expect(outcome.problems).toEqual([])
  })

  test('a stream destroyed before it ended is a failed drain', async () => {
    const outcome = await drainOutputStreams([destroyedBeforeEndStream()], 25)
    expect(outcome.completed).toBe(false)
    expect(outcome.problems).toHaveLength(1)
    expect(outcome.problems[0]).toContain('was destroyed before it ended')
  })

  test('a stream that closes before it ends is a failed drain', async () => {
    const outcome = await drainOutputStreams([closingBeforeEndStream()], 1_000)
    expect(outcome.completed).toBe(false)
    expect(outcome.problems).toHaveLength(1)
    expect(outcome.problems[0]).toContain('closed before it ended')
  })

  test('a stream that fails is a failed drain, and the reason carries no stream text', async () => {
    const outcome = await drainOutputStreams([failingStream()], 1_000)
    expect(outcome.completed).toBe(false)
    expect(outcome.problems).toHaveLength(1)
    expect(outcome.problems[0]).toContain('failed while draining')
    // The reason is fixed: no error text, no path, no value.
    expect(outcome.problems[0]).not.toMatch(/Error|error:|at |\//)
  })

  test('a stream that fails reaches the verdict through the teardown', async () => {
    const ledger = createLogFailureLedger()
    const stopper = createFinalizingStop({
      signal: () => {},
      exit: { exitCode: 0, signalCode: null, once: () => undefined, off: () => undefined },
      streams: [failingStream()],
      close: () => {},
      ledger,
      bounds: { exit: 25, drain: 1_000 },
    })
    await stopper.stop()
    expect(stopper.problems()).toHaveLength(1)
    expect(ledger.count()).toBe(1)
    const result = await finalizeAndAssessLaunches(
      [
        {
          pid: 1,
          logPath: '/nonexistent/app.log',
          logWriteFailures: () => ledger.count(),
          stop: () => stopper.stop(),
        },
      ],
      ledger
    )
    expect(result.completeness.status).toBe('fail')
    expect(result.completeness.actual).toContain('1 log write failure')
  })

  test('a destroyed stream and a closing stream are both reported', async () => {
    const outcome = await drainOutputStreams(
      [destroyedBeforeEndStream(), closingBeforeEndStream()],
      1_000
    )
    expect(outcome.completed).toBe(false)
    expect(outcome.problems).toHaveLength(2)
    expect(outcome.problems[0]).toContain('destroyed before it ended')
    expect(outcome.problems[1]).toContain('closed before it ended')
  })
})
