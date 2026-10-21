import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  assertFreshAccountReceipt,
  buildFreshAccountArtifact,
  gateAcceptanceReceipt,
  main,
  parseAcceptanceReceipt,
} from './ci-fresh-account-acceptance.mjs'
import { buildAcceptanceReceipt } from './fresh-postgres-acceptance/acceptance-receipt.mjs'
import { assertDatabaseProof, recoveryArtifact } from './fresh-postgres-acceptance/recovery.mjs'

const scriptPath = resolve(import.meta.dir, 'ci-fresh-account-acceptance.mjs')
const head = 'a'.repeat(40)
const other = 'b'.repeat(40)

/**
 * The gate as the job runs it: the module is a program here, not an import.
 *
 * The job runs it with the repository's Node runtime, so the program is run
 * with Node here too, and not only with the test runner's own binary.
 */
const runGate = (args: string[], environment: Record<string, string> = {}) => {
  const result = spawnSync('node', [scriptPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** A receipt the acceptance lane would print, with a journey that executed. */
function receipt(overrides: Record<string, unknown> = {}) {
  return {
    status: 'passed',
    migrations: 60,
    verificationRequired: true,
    evidence: 'local-disposable',
    proofKind: 'fresh-schema-acceptance',
    postgres: 'disposable-instance',
    checkout: { sha: head, dirty: false, source: 'HEAD' },
    module: { sha: head, dirty: false, source: 'HEAD' },
    desktopPrincipal: {
      accounts: 3,
      exchanges: 1,
      mappedUsers: 3,
      orphanUsers: 0,
      provider: 'better-auth',
      refused: { origin: 1, pkce: 1, replay: 1 },
    },
    ...overrides,
  }
}

describe('the fresh-account acceptance receipt gate', () => {
  test('it accepts a proof of the exact head with a journey that executed', () => {
    const proven = assertFreshAccountReceipt(receipt(), { expectedSha: head })
    expect(proven.checkout.sha).toBe(head)
    expect(proven.journey.accounts).toBe(3)
    expect(proven.journey.exchanges).toBe(1)
  })

  test('it refuses a receipt that names another head', () => {
    expect(() => assertFreshAccountReceipt(receipt(), { expectedSha: other })).toThrow(
      'does not name the exact head the job checked out'
    )
  })

  test('it refuses a receipt from a dirty tree', () => {
    expect(() =>
      assertFreshAccountReceipt(receipt({ checkout: { sha: head, dirty: true, source: 'HEAD' } }), {
        expectedSha: head,
      })
    ).toThrow('not clean')
  })

  test('it refuses a receipt whose code came from another tree', () => {
    expect(() =>
      assertFreshAccountReceipt(receipt({ module: { sha: other, dirty: false, source: 'HEAD' } }), {
        expectedSha: head,
      })
    ).toThrow('different tree than the code came from')
  })

  test('it refuses a result that executed no journey', () => {
    expect(() =>
      assertFreshAccountReceipt(receipt({ desktopPrincipal: undefined }), { expectedSha: head })
    ).toThrow('no journey result')
  })

  test('it refuses a zero-pass result', () => {
    for (const name of ['accounts', 'mappedUsers', 'exchanges']) {
      const journey = { ...receipt().desktopPrincipal, [name]: 0 }
      expect(() =>
        assertFreshAccountReceipt(receipt({ desktopPrincipal: journey }), { expectedSha: head })
      ).toThrow('no executed ' + name)
    }
  })

  test('it refuses a result that refused nothing', () => {
    for (const name of ['origin', 'pkce', 'replay']) {
      const journey = {
        ...receipt().desktopPrincipal,
        refused: { origin: 1, pkce: 1, replay: 1, [name]: 0 },
      }
      expect(() =>
        assertFreshAccountReceipt(receipt({ desktopPrincipal: journey }), { expectedSha: head })
      ).toThrow('no refused ' + name)
    }
    const journey = { ...receipt().desktopPrincipal, refused: undefined }
    expect(() =>
      assertFreshAccountReceipt(receipt({ desktopPrincipal: journey }), { expectedSha: head })
    ).toThrow('no refused journey case')
  })

  test('it refuses a result that did not run the real provider', () => {
    const journey = { ...receipt().desktopPrincipal, provider: 'synthetic-child' }
    expect(() =>
      assertFreshAccountReceipt(receipt({ desktopPrincipal: journey }), { expectedSha: head })
    ).toThrow('did not run the real provider')
  })

  test('it refuses a simulated result and a failed one', () => {
    expect(() =>
      assertFreshAccountReceipt(receipt({ evidence: 'simulated' }), { expectedSha: head })
    ).toThrow('simulated')
    expect(() =>
      assertFreshAccountReceipt(receipt({ status: 'failed' }), { expectedSha: head })
    ).toThrow('not a passed proof')
  })

  test('it refuses a receipt of another proof kind', () => {
    // The shared database-proof check accepts every kind the repository knows,
    // and the disposable proof's receipt is a different proof of a different
    // thing. Only the acceptance lane's own kind qualifies here.
    const disposable = receipt({
      proofKind: 'disposable-postgres-proof',
      migrations: { checks: [{ name: 'schema' }] },
    })
    expect(() => assertFreshAccountReceipt(disposable, { expectedSha: head })).toThrow(
      'not a fresh-schema acceptance proof'
    )
    expect(() =>
      assertFreshAccountReceipt(receipt({ proofKind: undefined }), { expectedSha: head })
    ).toThrow('not a fresh-schema acceptance proof')
  })

  test('it refuses a receipt that carries an orphan user', () => {
    const journey = { ...receipt().desktopPrincipal, orphanUsers: 1 }
    expect(() =>
      assertFreshAccountReceipt(receipt({ desktopPrincipal: journey }), { expectedSha: head })
    ).toThrow('shows an orphan user')
  })

  test('it refuses an expected head that is not an exact commit', () => {
    expect(() => assertFreshAccountReceipt(receipt(), { expectedSha: 'HEAD' })).toThrow(
      'not an exact commit'
    )
    expect(() => assertFreshAccountReceipt(receipt(), {})).toThrow('not an exact commit')
  })
})

describe('the published artifact', () => {
  test('it carries the class the source may claim and keeps the lane’s own', () => {
    const artifact = buildFreshAccountArtifact(receipt(), {
      environment: { GITHUB_ACTIONS: 'true' },
      head,
      runId: '42',
      workflow: 'Database Proof',
      repository: 'adea-ai/adea',
    })
    expect(artifact.evidence).toBe('ci')
    expect(artifact.laneEvidence).toBe('local-disposable')
    expect(artifact.ciRun).toEqual({
      head,
      runId: '42',
      workflow: 'Database Proof',
      repository: 'adea-ai/adea',
    })
    // The lane’s own fields are untouched.
    expect(artifact.proofKind).toBe('fresh-schema-acceptance')
    expect(artifact.desktopPrincipal.accounts).toBe(3)
    // The evidence the job publishes is sanitized: it names the commit, the
    // class and the measured counts, and nothing that could carry a credential.
    const published = JSON.stringify(artifact)
    expect(published).not.toContain('postgresql://')
    expect(published).not.toContain('password')
    expect(published).not.toContain('secret')
  })

  test('outside CI the class is the lane’s own', () => {
    const artifact = buildFreshAccountArtifact(receipt(), { environment: {} })
    expect(artifact.evidence).toBe('local-disposable')
    expect(artifact.laneEvidence).toBe('local-disposable')
  })
})

describe('the receipt the lane printed', () => {
  test('it is the last JSON line of the run’s output', () => {
    const output = ['some noise', JSON.stringify({ partial: true }), JSON.stringify(receipt())]
    expect(parseAcceptanceReceipt(output.join('\n')).proofKind).toBe('fresh-schema-acceptance')
  })

  test('output without a receipt is refused', () => {
    expect(() => parseAcceptanceReceipt('nothing here')).toThrow('printed no receipt')
    expect(() => parseAcceptanceReceipt('{ not json }')).toThrow('printed no receipt')
  })
})

describe('the job’s gate', () => {
  test('it writes the artifact and reports the proof', () => {
    const directory = mkdtempSync(join(tmpdir(), 'adea-acceptance-gate-'))
    try {
      const receiptFile = join(directory, 'receipt.out')
      const artifactFile = join(directory, 'receipt.json')
      writeFileSync(receiptFile, `${JSON.stringify(receipt())}\n`)
      const result = gateAcceptanceReceipt({
        receiptFile,
        expectedSha: head,
        artifactFile,
        environment: { GITHUB_ACTIONS: 'true' },
      })
      expect(result.proven.checkout.sha).toBe(head)
      const published = JSON.parse(readFileSync(artifactFile, 'utf8'))
      expect(published.evidence).toBe('ci')
      expect(published.desktopPrincipal.exchanges).toBe(1)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a refused receipt writes no artifact', () => {
    const directory = mkdtempSync(join(tmpdir(), 'adea-acceptance-gate-'))
    try {
      const receiptFile = join(directory, 'receipt.out')
      const artifactFile = join(directory, 'receipt.json')
      writeFileSync(receiptFile, `${JSON.stringify(receipt())}\n`)
      expect(() =>
        gateAcceptanceReceipt({ receiptFile, expectedSha: other, artifactFile })
      ).toThrow('does not name the exact head the job checked out')
      expect(() => readFileSync(artifactFile, 'utf8')).toThrow()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('the gate as the job runs it', () => {
  test('a proof of the exact head exits zero and publishes the receipt', () => {
    const directory = mkdtempSync(join(tmpdir(), 'adea-acceptance-cli-'))
    try {
      const receiptFile = join(directory, 'receipt.out')
      const artifactFile = join(directory, 'receipt.json')
      writeFileSync(receiptFile, `${JSON.stringify(receipt())}\n`)
      const result = runGate([receiptFile, head, artifactFile], { GITHUB_ACTIONS: 'true' })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain(head)
      const published = JSON.parse(readFileSync(artifactFile, 'utf8'))
      expect(published.evidence).toBe('ci')
      expect(published.ciRun.head).toBe(head)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a receipt of another head exits nonzero and publishes nothing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'adea-acceptance-cli-'))
    try {
      const receiptFile = join(directory, 'receipt.out')
      const artifactFile = join(directory, 'receipt.json')
      writeFileSync(receiptFile, `${JSON.stringify(receipt())}\n`)
      const result = runGate([receiptFile, other, artifactFile])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('does not name the exact head the job checked out')
      expect(existsSync(artifactFile)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a run that printed no receipt exits nonzero', () => {
    const directory = mkdtempSync(join(tmpdir(), 'adea-acceptance-cli-'))
    try {
      const receiptFile = join(directory, 'receipt.out')
      writeFileSync(receiptFile, 'the lane failed before it printed a receipt\n')
      const result = runGate([receiptFile, head, join(directory, 'receipt.json')])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('printed no receipt')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a missing argument exits with the usage', () => {
    const result = runGate([join(tmpdir(), 'nothing.out')])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('usage: ci-fresh-account-acceptance.mjs')
  })
})

describe('the program the job runs', () => {
  test('a proof of the exact head is a pass, a refused receipt is a failure', () => {
    const directory = mkdtempSync(join(tmpdir(), 'adea-acceptance-main-'))
    try {
      const receiptFile = join(directory, 'receipt.out')
      const artifactFile = join(directory, 'receipt.json')
      writeFileSync(receiptFile, `${JSON.stringify(receipt())}\n`)
      const messages: string[] = []
      const options = { environment: { GITHUB_ACTIONS: 'true' }, log: () => {}, fail: () => {} }
      expect(main([receiptFile, head, artifactFile], options)).toBe(0)
      expect(
        main([receiptFile, other, artifactFile], {
          ...options,
          fail: (m: string) => messages.push(m),
        })
      ).toBe(1)
      expect(messages.join('\n')).toContain('does not name the exact head the job checked out')
      expect(main(['only-one-argument'], options)).toBe(2)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

/**
 * The receipt the acceptance lane publishes, built by the acceptance lane's
 * own builder, so the gate is proved against what the producer produces and
 * not against a copy of it.
 */
const produced = () =>
  buildAcceptanceReceipt({
    migrations: 60,
    evidence: 'local-disposable',
    checkout: { sha: head, dirty: false, source: 'HEAD' },
    module: { sha: head, dirty: false, source: 'HEAD' },
    desktopPrincipal: {
      accounts: 3,
      exchanges: 1,
      mappedUsers: 3,
      orphanUsers: 0,
      provider: 'better-auth',
      refused: { origin: 1, pkce: 1, replay: 1 },
    },
  })

describe('the receipt the producer publishes', () => {
  test('the gate accepts the receipt the acceptance lane builds', () => {
    const proven = assertFreshAccountReceipt(produced(), { expectedSha: head })
    expect(proven.checkout.sha).toBe(head)
    expect(proven.journey.accounts).toBe(3)
    expect(proven.journey.orphanUsers).toBe(0)
  })

  test('the artifact the job publishes is a receipt the recovery procedure can consume', () => {
    const artifact = buildFreshAccountArtifact(produced(), {
      environment: { GITHUB_ACTIONS: 'true' },
      head,
      runId: '42',
      workflow: 'Database Proof',
      repository: 'adea-ai/adea',
    })
    // The lane's own checks accept the published artifact: the class the
    // workflow relabels it to is one the lane's evidence model grants, and the
    // recovery procedure can name the commit the run happened in.
    expect(assertDatabaseProof(artifact)).toEqual({
      proofKind: 'fresh-schema-acceptance',
      evidence: 'ci',
    })
    const named = recoveryArtifact(artifact)
    expect(named.commit).toBe(head)
    expect(named.dirty).toBe(false)
    expect(named.proofKind).toBe('fresh-schema-acceptance')
  })
})
