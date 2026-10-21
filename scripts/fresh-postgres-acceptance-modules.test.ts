import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  JOURNEY_RECEIPT_PREFIX,
  assertFocusedJourneyPassed,
  buildAcceptanceReceipt,
  countSkippedTests,
  parseJourneyReceipt,
} from './fresh-postgres-acceptance/acceptance-receipt.mjs'
import {
  EVIDENCE_CLASSES,
  EVIDENCE_SOURCES,
  assertEvidenceClass,
  assertEvidenceNotPromoted,
  classifyDisposableProofEvidence,
  classifyEvidence,
  receiptEvidence,
} from './fresh-postgres-acceptance/evidence.mjs'
import {
  assertReproducibleProvenance,
  readCheckoutProvenance,
} from './fresh-postgres-acceptance/provenance.mjs'
import {
  DATABASE_PROOFS,
  NOT_PROVED_BY_THE_PROOF,
  RECOVERY_METHODS,
  assertDatabaseProof,
  assertRecoveryMethod,
  assertTestedRecoveryArtifact,
  recoveryArtifact,
  recoveryPlan,
} from './fresh-postgres-acceptance/recovery.mjs'

// The behavior of the modules the acceptance lane is built from.
//
// These are the measured modules of the lane, and the coverage lane runs this
// file, so their behavior is exercised where the measurement happens. Every
// module is read through its own contract: a receipt is parsed or refused, a
// class is granted or refused, a provenance is read or refused, and an
// artifact is named only by a receipt that is a real, passed database proof.

const cleanProvenance = {
  sha: '0123456789abcdef0123456789abcdef01234567',
  dirty: false,
  source: 'test/branch',
}

function temporaryRepository(): { root: string; sha: string; source: string } {
  const root = mkdtempSync(join(tmpdir(), 'adea-receipt-'))
  const run = (args: string[]) => {
    const result = require('node:child_process').spawnSync('git', args, {
      cwd: root,
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    return result.stdout.trim()
  }
  run(['init', '-q'])
  writeFileSync(join(root, 'README.md'), 'synthetic\n')
  run(['add', '-A'])
  run([
    '-c',
    'user.name=synthetic',
    '-c',
    'user.email=synthetic@example.invalid',
    'commit',
    '-q',
    '-m',
    'synthetic',
  ])
  return {
    root,
    sha: run(['rev-parse', 'HEAD']),
    source: run(['rev-parse', '--abbrev-ref', 'HEAD']),
  }
}

describe('the receipt of a focused journey', () => {
  test('a printed receipt is parsed, and a missing one is not', () => {
    expect(JOURNEY_RECEIPT_PREFIX).toBe('DESKTOP_PRINCIPAL_JOURNEY ')
    expect(parseJourneyReceipt('DESKTOP_PRINCIPAL_JOURNEY {"status":"passed"}\n')).toEqual({
      status: 'passed',
    })
    expect(parseJourneyReceipt('DESKTOP_PRINCIPAL_JOURNEY {"status":"passed"}\nother\n')).toEqual({
      status: 'passed',
    })
    expect(parseJourneyReceipt('nothing here')).toBeNull()
    expect(parseJourneyReceipt('DESKTOP_PRINCIPAL_JOURNEY not json\n')).toBeNull()
    expect(parseJourneyReceipt('DESKTOP_PRINCIPAL_JOURNEY ["not","an","object"]\n')).toBeNull()
    expect(parseJourneyReceipt(undefined)).toBeNull()
  })

  test('the skipped tests of a run are counted', () => {
    expect(countSkippedTests(' 3 pass\n 1 skip\n')).toBe(1)
    expect(countSkippedTests(' 3 pass\n 0 skip\n')).toBe(0)
    expect(countSkippedTests('no counts here')).toBe(0)
  })

  test('a focused journey has to have run, and has to have passed', () => {
    const passed = ' 2 pass\n 0 fail\n 0 skip\nDESKTOP_PRINCIPAL_JOURNEY {"status":"passed"}\n'
    expect(assertFocusedJourneyPassed(passed)).toEqual({ status: 'passed' })
    expect(() => assertFocusedJourneyPassed(' 2 pass\n 0 fail\n 0 skip\n')).toThrow(
      /produced no receipt/
    )
    expect(() => assertFocusedJourneyPassed(' 2 pass\n 1 skip\n')).toThrow(/skipped 1 test/)
    expect(() =>
      assertFocusedJourneyPassed('DESKTOP_PRINCIPAL_JOURNEY {"status":"failed"}\n')
    ).toThrow(/did not pass/)
  })

  test('the acceptance receipt carries the evidence, the kind and the roots', () => {
    const receipt = buildAcceptanceReceipt({
      migrations: 60,
      evidence: 'local-disposable',
      checkout: cleanProvenance,
      module: cleanProvenance,
      desktopPrincipal: { accounts: 3, mappedUsers: 3, orphanUsers: 0 },
    })
    expect(receipt.status).toBe('passed')
    expect(receipt.proofKind).toBe('fresh-schema-acceptance')
    expect(receipt.postgres).toBe('disposable-instance')
    expect(receipt.evidence).toBe('local-disposable')
    expect(receipt.checkout).toEqual(cleanProvenance)
    expect(receipt.module).toEqual(cleanProvenance)
    expect(receipt.desktopPrincipal).toEqual({ accounts: 3, mappedUsers: 3, orphanUsers: 0 })
    const without = buildAcceptanceReceipt({
      migrations: 60,
      evidence: 'local-disposable',
      checkout: cleanProvenance,
      module: cleanProvenance,
    })
    expect(without.desktopPrincipal).toBeUndefined()
  })
})

describe('the class of an acceptance result', () => {
  test('a source is classified, and only a live source needs an authorization', () => {
    expect(EVIDENCE_CLASSES).toEqual(['simulated', 'local-disposable', 'ci', 'live'])
    expect(Object.keys(EVIDENCE_SOURCES).toSorted()).toEqual([
      'ci-disposable-proof',
      'live-railway',
      'local-disposable',
      'memory-journey',
      'synthetic-child',
    ])
    expect(classifyEvidence('synthetic-child')).toBe('simulated')
    expect(classifyEvidence('memory-journey')).toBe('simulated')
    expect(classifyEvidence('local-disposable')).toBe('local-disposable')
    expect(classifyEvidence('ci-disposable-proof')).toBe('ci')
    expect(() => classifyEvidence('live-railway')).toThrow(/not authorized/)
    expect(classifyEvidence('live-railway', { authorized: true })).toBe('live')
    expect(() => classifyEvidence('unknown-source')).toThrow(/unknown acceptance evidence source/)
  })

  test('a real disposable run is classified by where it ran', () => {
    expect(classifyDisposableProofEvidence({})).toBe('local-disposable')
    expect(classifyDisposableProofEvidence({ GITHUB_ACTIONS: 'false' })).toBe('local-disposable')
    expect(classifyDisposableProofEvidence({ GITHUB_ACTIONS: 'true' })).toBe('ci')
  })

  test('a class has to be one the lane knows', () => {
    expect(assertEvidenceClass('simulated')).toBe('simulated')
    expect(assertEvidenceClass('live')).toBe('live')
    expect(() => assertEvidenceClass('strong')).toThrow(/unknown acceptance evidence class/)
    expect(() => assertEvidenceClass(undefined)).toThrow(/unknown acceptance evidence class/)
  })

  test('a receipt may not claim more than its source produced', () => {
    expect(assertEvidenceNotPromoted({ evidence: 'simulated' }, 'synthetic-child')).toBe(
      'simulated'
    )
    expect(assertEvidenceNotPromoted({ evidence: 'local-disposable' }, 'local-disposable')).toBe(
      'local-disposable'
    )
    expect(assertEvidenceNotPromoted({ evidence: 'ci' }, 'ci-disposable-proof')).toBe('ci')
    expect(() => assertEvidenceNotPromoted({ evidence: 'ci' }, 'synthetic-child')).toThrow(
      /stronger than its source/
    )
    expect(() => assertEvidenceNotPromoted({ evidence: 'live' }, 'local-disposable')).toThrow(
      /stronger than its source/
    )
    expect(() => assertEvidenceNotPromoted({}, 'synthetic-child')).toThrow(
      /unknown acceptance evidence class/
    )
  })

  test('a receipt has to carry the class of its own source', () => {
    expect(receiptEvidence({ evidence: 'local-disposable' }, 'local-disposable')).toBe(
      'local-disposable'
    )
    expect(() => receiptEvidence({ evidence: 'simulated' }, 'local-disposable')).toThrow(
      /does not match its source/
    )
  })
})

describe('the provenance of a checkout', () => {
  test('the provenance of a clean checkout is read from the checkout', () => {
    const repository = temporaryRepository()
    try {
      const provenance = readCheckoutProvenance(repository.root)
      expect(provenance.sha).toBe(repository.sha)
      expect(provenance.dirty).toBe(false)
      expect(provenance.source).toBe(repository.source)
    } finally {
      rmSync(repository.root, { recursive: true, force: true })
    }
  })

  test('a checkout that cannot be read has no provenance', () => {
    const provenance = readCheckoutProvenance(join(tmpdir(), 'adea-no-such-checkout'))
    expect(provenance.sha).toBe('')
    expect(provenance.dirty).toBeNull()
    expect(provenance.source).toBe('unavailable')
  })

  test('a provenance has to name a commit and a clean tree', () => {
    expect(assertReproducibleProvenance(cleanProvenance)).toEqual(cleanProvenance)
    expect(() => assertReproducibleProvenance(undefined)).toThrow(/does not name the exact commit/)
    expect(() => assertReproducibleProvenance({ ...cleanProvenance, sha: 'not-a-sha' })).toThrow(
      /does not name the exact commit/
    )
    expect(() => assertReproducibleProvenance({ ...cleanProvenance, dirty: true })).toThrow(
      /not clean/
    )
    expect(() => assertReproducibleProvenance({ ...cleanProvenance, source: '' })).toThrow(
      /does not name the source/
    )
  })
})

describe('the artifact a recovery may name', () => {
  const acceptanceReceipt = {
    status: 'passed',
    migrations: 60,
    verificationRequired: true,
    postgres: 'disposable-instance',
    evidence: 'local-disposable',
    proofKind: 'fresh-schema-acceptance',
    checkout: cleanProvenance,
    module: cleanProvenance,
  }
  const disposableReceipt = {
    status: 'passed',
    proofKind: 'disposable-postgres-proof',
    evidence: 'local-disposable',
    migrations: { checks: [{ command: 'bun', args: ['db:check'] }] },
    auth: { applied: true, created: ['user'], replayApplied: false, schema: 'auth_ci' },
    checkout: cleanProvenance,
    module: cleanProvenance,
  }

  test('the recovery methods are a forward-fix or a backup and restore', () => {
    expect(RECOVERY_METHODS).toEqual(['forward-fix', 'railway-backup-restore'])
    expect(assertRecoveryMethod('forward-fix')).toBe('forward-fix')
    expect(assertRecoveryMethod('railway-backup-restore')).toBe('railway-backup-restore')
    for (const method of ['neon-rollback', 'legacy-artifact', 'previous-deployment', '']) {
      expect(() => assertRecoveryMethod(method)).toThrow(/unsupported recovery method/)
    }
  })

  test('a receipt that is not a passed database proof names no artifact', () => {
    expect(assertDatabaseProof(acceptanceReceipt)).toEqual({
      proofKind: 'fresh-schema-acceptance',
      evidence: 'local-disposable',
    })
    expect(() => assertDatabaseProof({ ...acceptanceReceipt, status: 'failed' })).toThrow(
      /not a passed proof/
    )
    expect(() =>
      assertDatabaseProof({ ...acceptanceReceipt, proofKind: 'memory-journey' })
    ).toThrow(/not a database proof/)
    expect(() => assertDatabaseProof({ ...acceptanceReceipt, evidence: 'simulated' })).toThrow(
      /simulated result does not prove a database/
    )
    expect(() => assertDatabaseProof({ ...acceptanceReceipt, migrations: 0 })).toThrow(
      /does not carry the result the proof observed/
    )
  })

  test('the artifact of a real receipt names the commit it ran at', () => {
    const artifact = assertTestedRecoveryArtifact(acceptanceReceipt)
    expect(artifact.commit).toBe(cleanProvenance.sha)
    expect(artifact.source).toBe(cleanProvenance.source)
    expect(artifact.proofKind).toBe('fresh-schema-acceptance')
    expect(artifact.proved).toEqual(DATABASE_PROOFS['fresh-schema-acceptance'].guarantees)
    expect(artifact.notProved).toEqual(NOT_PROVED_BY_THE_PROOF)
    expect(artifact.proved.some((entry) => entry.includes('backup restores'))).toBe(false)
    const disposable = recoveryArtifact(disposableReceipt)
    expect(disposable.proofKind).toBe('disposable-postgres-proof')
    expect(disposable.proved.some((entry) => entry.includes('backup restores'))).toBe(true)
  })

  test('a receipt from two checkouts names no artifact', () => {
    expect(() =>
      recoveryArtifact({
        ...acceptanceReceipt,
        module: { ...cleanProvenance, sha: 'f'.repeat(40) },
      })
    ).toThrow(/mixes two checkouts/)
  })

  test('the recovery plan names the artifact and the live steps', () => {
    const plan = recoveryPlan(acceptanceReceipt)
    expect(plan.artifact.commit).toBe(cleanProvenance.sha)
    expect(plan.methods.map((entry) => entry.method)).toEqual([
      'forward-fix',
      'railway-backup-restore',
    ])
    for (const entry of plan.methods) {
      expect(entry.steps.length).toBeGreaterThan(0)
      expect(entry.liveAction).toMatch(/root-owned live operation/)
    }
  })
})
