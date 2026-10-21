import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  assertBuiltWorkerReceipt,
  BUILT_WORKER_PROOF_KIND,
  BUILT_WORKER_RECEIPT_PREFIX,
  gateBuiltWorkerReceipt,
  main,
  parseBuiltWorkerReceipt,
} from './ci-built-worker-desktop-auth.mjs'

// The CI gate for the built-Worker desktop-auth receipt.
//
// The receipt the qualification publishes is the one the contract describes, so
// the gate is proved against that shape: a proof of the exact head with every
// assertion passed and its own cleanup settled, and every way of not being
// that proof refused.

const scriptPath = resolve(import.meta.dir, 'ci-built-worker-desktop-auth.mjs')
const head = 'a'.repeat(40)
const other = 'b'.repeat(40)

/** A receipt the qualification would publish. */
function receipt(overrides: Record<string, unknown> = {}) {
  return {
    status: 'passed',
    proofKind: 'built-worker-desktop-auth',
    evidence: 'ci',
    worker: {
      built: true,
      baseUrl: 'http://127.0.0.1:4789',
      routes: ['/api/auth/desktop/authorize', '/api/auth/desktop/exchange'],
      artifact: {
        digest: 'c'.repeat(64),
        sha: head,
        dirty: false,
        verified: true,
      },
    },
    assertions: [
      {
        name: 'the authorize route refuses a caller without a session',
        passed: true,
        detail: '',
        attempts: 1,
        outcomes: ['passed'],
      },
      {
        name: 'the exchange route refuses a wrong PKCE verifier',
        passed: true,
        detail: '',
        attempts: 1,
        outcomes: ['passed'],
      },
    ],
    passed: 2,
    failed: 0,
    authLifecycle: { suite: 'suite', assertions: ['one'], passed: 1 },
    cleanup: { workerStopped: true, containerRemoved: true, materialRemoved: true },
    checkout: { sha: head, dirty: false, source: 'HEAD' },
    module: { sha: head, dirty: false, source: 'HEAD' },
    ...overrides,
  }
}

/** The receipt as the qualification prints it. */
const printed = (value: Record<string, unknown> = receipt()) =>
  `${BUILT_WORKER_RECEIPT_PREFIX}${JSON.stringify(value)}\n`

/**
 * The gate as the job runs it: the module is a program here, not an import.
 *
 * The job runs the gate with the repository's Node runtime, so the program is
 * run with Node here too.
 */
const runGate = (args: string[], environment: Record<string, string> = {}) => {
  const result = spawnSync('node', [scriptPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

describe('the built-Worker receipt gate', () => {
  test('it accepts a proof of the exact head with passed assertions and a settled cleanup', () => {
    const proven = assertBuiltWorkerReceipt(receipt(), { expectedSha: head })
    expect(proven.checkout.sha).toBe(head)
    expect(proven.artifact.digest).toBe('c'.repeat(64))
    expect(proven.cleanup.workerStopped).toBe(true)
  })

  test('it refuses a receipt of another proof kind', () => {
    expect(() =>
      assertBuiltWorkerReceipt(receipt({ proofKind: 'fresh-schema-acceptance' }), {
        expectedSha: head,
      })
    ).toThrow('not a built-Worker desktop-auth proof')
    expect(() =>
      assertBuiltWorkerReceipt(receipt({ proofKind: undefined }), { expectedSha: head })
    ).toThrow('not a built-Worker desktop-auth proof')
  })

  test('it refuses a failed or a simulated result', () => {
    expect(() =>
      assertBuiltWorkerReceipt(receipt({ status: 'failed' }), { expectedSha: head })
    ).toThrow('not a passed proof')
    expect(() =>
      assertBuiltWorkerReceipt(receipt({ evidence: 'simulated' }), { expectedSha: head })
    ).toThrow('simulated result does not prove')
  })

  test('it accepts a receipt that carries a real evidence class', () => {
    expect(
      assertBuiltWorkerReceipt(receipt({ evidence: 'ci' }), { expectedSha: head }).checkout.sha
    ).toBe(head)
    expect(
      assertBuiltWorkerReceipt(receipt({ evidence: 'local-disposable' }), { expectedSha: head })
        .checkout.sha
    ).toBe(head)
  })

  test('it refuses a receipt that does not say how much it is worth', () => {
    expect(() =>
      assertBuiltWorkerReceipt(receipt({ evidence: undefined }), { expectedSha: head })
    ).toThrow('does not carry a real evidence class')
    expect(() =>
      assertBuiltWorkerReceipt(receipt({ evidence: 'live' }), { expectedSha: head })
    ).toThrow('does not carry a real evidence class')
  })

  test('it refuses a run that proved nothing or that failed an assertion', () => {
    expect(() =>
      assertBuiltWorkerReceipt(receipt({ passed: 0, failed: 0 }), { expectedSha: head })
    ).toThrow('the built-Worker qualification failed')
    const failed = receipt({
      passed: 1,
      failed: 1,
      assertions: [
        {
          name: 'the exchange route refuses a replayed code',
          passed: false,
          detail: '',
          attempts: 2,
          outcomes: ['refused'],
        },
      ],
    })
    expect(() => assertBuiltWorkerReceipt(failed, { expectedSha: head })).toThrow(
      'the built-Worker qualification failed'
    )
  })

  test('it refuses a receipt that names another head', () => {
    expect(() => assertBuiltWorkerReceipt(receipt(), { expectedSha: other })).toThrow(
      'does not name the exact head'
    )
    expect(() => assertBuiltWorkerReceipt(receipt(), { expectedSha: 'HEAD' })).toThrow(
      'not an exact commit'
    )
    expect(() => assertBuiltWorkerReceipt(receipt(), {})).toThrow('not an exact commit')
  })

  test('it refuses a receipt from a dirty or a foreign tree', () => {
    expect(() =>
      assertBuiltWorkerReceipt(receipt({ checkout: { sha: head, dirty: true, source: 'HEAD' } }), {
        expectedSha: head,
      })
    ).toThrow('not clean')
    expect(() =>
      assertBuiltWorkerReceipt(receipt({ module: { sha: other, dirty: false, source: 'HEAD' } }), {
        expectedSha: head,
      })
    ).toThrow('different tree')
  })

  test('it refuses a receipt that does not name a built Worker', () => {
    expect(() =>
      assertBuiltWorkerReceipt(
        receipt({ worker: { ...(receipt().worker as Record<string, unknown>), built: false } }),
        { expectedSha: head }
      )
    ).toThrow('does not name a built Worker')
  })

  test('it refuses a Worker that was not proved to belong to this checkout', () => {
    expect(() =>
      assertBuiltWorkerReceipt(
        receipt({
          worker: {
            ...(receipt().worker as Record<string, unknown>),
            artifact: { digest: 'c'.repeat(64), sha: head, dirty: false, verified: false },
          },
        }),
        { expectedSha: head }
      )
    ).toThrow('not proved to belong to this checkout')
    expect(() =>
      assertBuiltWorkerReceipt(
        receipt({
          worker: {
            ...(receipt().worker as Record<string, unknown>),
            artifact: { digest: 'c'.repeat(64), sha: other, dirty: false, verified: true },
          },
        }),
        { expectedSha: head }
      )
    ).toThrow('built from another commit')
    expect(() =>
      assertBuiltWorkerReceipt(
        receipt({
          worker: {
            ...(receipt().worker as Record<string, unknown>),
            artifact: { digest: 'c'.repeat(64), sha: head, dirty: true, verified: true },
          },
        }),
        { expectedSha: head }
      )
    ).toThrow('not clean')
  })

  test('it refuses a receipt whose cleanup did not settle', () => {
    expect(() =>
      assertBuiltWorkerReceipt(receipt({ cleanup: undefined }), { expectedSha: head })
    ).toThrow('carries no cleanup verdict')
    expect(() =>
      assertBuiltWorkerReceipt(
        receipt({
          cleanup: { workerStopped: false, containerRemoved: true, materialRemoved: true },
        }),
        { expectedSha: head }
      )
    ).toThrow('did not clean up')
    expect(() =>
      assertBuiltWorkerReceipt(
        receipt({
          cleanup: { workerStopped: true, containerRemoved: true, materialRemoved: false },
        }),
        { expectedSha: head }
      )
    ).toThrow('did not clean up')
  })
})

describe('the receipt the qualification printed', () => {
  test('it is the prefixed line the qualification prints', () => {
    expect(parseBuiltWorkerReceipt(printed()).proofKind).toBe('built-worker-desktop-auth')
    expect(parseBuiltWorkerReceipt(`noise\n${printed()}`).status).toBe('passed')
  })

  test('output without a receipt is refused', () => {
    expect(() => parseBuiltWorkerReceipt('nothing here')).toThrow('printed no receipt')
    expect(() => parseBuiltWorkerReceipt(`${BUILT_WORKER_RECEIPT_PREFIX}not json`)).toThrow(
      'printed no receipt'
    )
    expect(() => parseBuiltWorkerReceipt(`{"status":"passed"}`)).toThrow('printed no receipt')
  })
})

describe('the gate as the job runs it', () => {
  test('a proof of the exact head exits zero and publishes the receipt', () => {
    const directory = mkdtempSync(join(tmpdir(), 'adea-built-worker-gate-'))
    try {
      const receiptFile = join(directory, 'receipt.out')
      const artifactFile = join(directory, 'receipt.json')
      writeFileSync(receiptFile, printed())
      const result = runGate([receiptFile, head, artifactFile])
      expect(result.status).toBe(0)
      expect(result.stdout).toContain(head)
      const published = JSON.parse(readFileSync(artifactFile, 'utf8'))
      expect(published.proofKind).toBe('built-worker-desktop-auth')
      expect(published.worker.artifact.digest).toBe('c'.repeat(64))
      expect(published.worker.artifact.sha).toBe(head)
      expect(published.cleanup.materialRemoved).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a failed run exits nonzero and publishes no artifact', () => {
    const directory = mkdtempSync(join(tmpdir(), 'adea-built-worker-gate-'))
    try {
      const receiptFile = join(directory, 'receipt.out')
      const artifactFile = join(directory, 'receipt.json')
      writeFileSync(receiptFile, printed(receipt({ status: 'failed' })))
      const result = runGate([receiptFile, head, artifactFile])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('not a passed proof')
      expect(existsSync(artifactFile)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a run that printed no receipt exits nonzero and publishes no artifact', () => {
    const directory = mkdtempSync(join(tmpdir(), 'adea-built-worker-gate-'))
    try {
      const receiptFile = join(directory, 'receipt.out')
      const artifactFile = join(directory, 'receipt.json')
      writeFileSync(receiptFile, 'the qualification failed before it printed a receipt\n')
      const result = runGate([receiptFile, head, artifactFile])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('printed no receipt')
      expect(existsSync(artifactFile)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a missing argument exits with the usage', () => {
    const result = runGate([join(tmpdir(), 'nothing.out')])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('usage: ci-built-worker-desktop-auth.mjs')
  })

  test('the program reports the exit code the job sees', () => {
    const directory = mkdtempSync(join(tmpdir(), 'adea-built-worker-gate-'))
    try {
      const receiptFile = join(directory, 'receipt.out')
      const artifactFile = join(directory, 'receipt.json')
      writeFileSync(receiptFile, printed())
      const messages: string[] = []
      const options = { log: () => {}, fail: (message: string) => messages.push(message) }
      expect(main([receiptFile, head, artifactFile], options)).toBe(0)
      expect(
        main([receiptFile, other, artifactFile], {
          ...options,
          fail: (message: string) => messages.push(message),
        })
      ).toBe(1)
      expect(messages.join('\n')).toContain('does not name the exact head')
      expect(main(['only-one-argument'], options)).toBe(2)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('the gate and the artifact it writes', () => {
  test('it refuses a receipt and writes nothing when the proof is not one', () => {
    const directory = mkdtempSync(join(tmpdir(), 'adea-built-worker-gate-'))
    try {
      const artifactFile = join(directory, 'receipt.json')
      expect(() =>
        gateBuiltWorkerReceipt({ output: printed(), expectedSha: other, artifactFile })
      ).toThrow('does not name the exact head')
      expect(existsSync(artifactFile)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('the published artifact is the receipt the qualification published', () => {
    const directory = mkdtempSync(join(tmpdir(), 'adea-built-worker-gate-'))
    try {
      const artifactFile = join(directory, 'receipt.json')
      const original = receipt()
      gateBuiltWorkerReceipt({ output: printed(original), expectedSha: head, artifactFile })
      expect(JSON.parse(readFileSync(artifactFile, 'utf8'))).toEqual(original)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('the gate consumes the contract the qualification publishes', () => {
  // The contract is read, not imported: the qualification's modules are
  // TypeScript with extensionless internal imports, and importing them here
  // would put files this lane does not own into the coverage gate. The gate's
  // expectations are pinned against the contract's own source instead, so the
  // two cannot drift apart unnoticed.
  const contractRoot = resolve(import.meta.dir, 'fresh-postgres-acceptance')
  const qualification = readFileSync(
    resolve(import.meta.dir, 'built-worker-desktop-auth-cli.ts'),
    'utf8'
  )
  const proof = readFileSync(resolve(contractRoot, 'built-worker-desktop-auth.ts'), 'utf8')
  const runtime = readFileSync(resolve(contractRoot, 'built-worker-runtime.ts'), 'utf8')

  test('the proof kind and the receipt prefix are the ones the qualification uses', () => {
    expect(proof).toContain("BUILT_WORKER_DESKTOP_AUTH_PROOF_KIND = 'built-worker-desktop-auth'")
    expect(qualification).toContain('BUILT_WORKER_DESKTOP_AUTH ${')
    expect(BUILT_WORKER_PROOF_KIND).toBe('built-worker-desktop-auth')
    expect(BUILT_WORKER_RECEIPT_PREFIX).toBe('BUILT_WORKER_DESKTOP_AUTH ')
  })

  test('the pass rule the gate applies is the one the qualification states', () => {
    // Every assertion passed, and the run proved something.
    expect(proof).toContain('export function assertBuiltWorkerDesktopAuthPassed')
    expect(proof).toContain('assertion.passed')
    expect(proof).toContain('receipt.passed > 0')
  })

  test('the cleanup rule the gate applies is the one the qualification states', () => {
    // The receipt may only carry a pass once the Worker was stopped and its
    // material was removed, and never when the teardown itself failed.
    expect(runtime).toContain('export function mayPublishReceipt')
    expect(runtime).toContain('input.verdict.workerStopped && input.verdict.materialRemoved')
    expect(runtime).toContain('if (input.cleanupFailed) return false')
  })

  test('the fields the gate reads are the ones the receipt carries', () => {
    for (const field of [
      'status',
      'proofKind',
      'evidence',
      'worker',
      'assertions',
      'passed',
      'failed',
      'cleanup',
      'checkout',
      'module',
    ]) {
      // The cleanup verdict is the one field the receipt may carry without: a
      // receipt is published only once the teardown filled it in.
      expect(proof).toMatch(new RegExp(`readonly ${field}\\??:`))
    }
    expect(proof).toContain('readonly artifact: {')
    expect(proof).toContain('readonly verified: boolean')
    expect(proof).toContain('readonly workerStopped: boolean')
    expect(proof).toContain('readonly materialRemoved: boolean')
  })
})
