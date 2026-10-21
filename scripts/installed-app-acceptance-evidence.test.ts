// The installed-application acceptance lane's PUBLISHED EVIDENCE.
//
// The artifact and the screenshots committed under `docs/evidence/` are the
// record of a run that happened on a host this lane no longer controls. That
// run predates the repairs the lane's source now carries, so the current
// source can never reproduce the artifact: the source refuses to install,
// register or launch, and every row that needs the running application stays
// pending. A reader who opens the artifact alone must be able to see that, so
// the artifact carries a provenance block that says so.
//
// Nothing here installs, launches, registers or opens anything: every case
// reads the committed evidence and the lane's own row constants.
//
// What these cases pin:
//   - the artifact's own run fields are intact and are still the run's output;
//   - the provenance block agrees with the artifact it annotates, and names
//     exactly the rows the source plans and the artifact does not carry, so
//     the block cannot drift away from the source's row set;
//   - every capture the artifact names exists;
//   - no two captures in the directory share an index;
//   - every capture in the directory is either one the artifact names or one
//     explicitly labelled as an earlier capture.
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { LAUNCH_DEPENDENT_ROW_IDS } from './installed-app-acceptance'
import { INSTALLED_APP_UI_ROW_IDS } from './installed-app-ui-rows'

const root = resolve(import.meta.dir, '..')
const evidenceDirectory = join(
  root,
  'docs',
  'evidence',
  'installed-desktop-ui-acceptance-2026-10-20'
)
const artifactPath = join(evidenceDirectory, 'installed-app-acceptance.json')
const screenshotDirectory = join(evidenceDirectory, 'screenshots')

/** The rows the source adds outside the two named row lists. */
const INLINE_ROW_IDS = [
  'installed-bundle-identity',
  'the-acceptance-environment-names-no-neon-endpoint',
] as const

/** The rows the source plans for a run, derived from the source itself. */
function plannedRows(): string[] {
  return [...INLINE_ROW_IDS, ...LAUNCH_DEPENDENT_ROW_IDS, ...INSTALLED_APP_UI_ROW_IDS].toSorted()
}

type ArtifactCheck = {
  id: string
  expected: string
  actual: string
  ok: boolean
  screenshot?: string
}

type Artifact = {
  evidenceProvenance?: {
    note?: string
    runIsHistorical?: boolean
    publishedAt?: string
    runPredates?: string
    artifactRows?: number
    sourcePlannedRows?: number
    rowsInSourceNotInArtifact?: string[]
    sourceRevisionMatch?: { matches?: boolean; detail?: string }
    screenshots?: { referencedByArtifact?: number; note?: string }
    nativeAcceptance?: string
  }
  summary?: { passed?: number; failed?: number; total?: number; ok?: boolean }
  checks?: ArtifactCheck[]
}

const evidenceExists = existsSync(artifactPath) && existsSync(screenshotDirectory)
const readArtifact = (): Artifact => JSON.parse(readFileSync(artifactPath, 'utf8')) as Artifact

describe('the published acceptance artifact', () => {
  test.skipIf(!evidenceExists)('its own run fields are intact', () => {
    const artifact = readArtifact()
    // The annotation is the only addition: every run field is still present.
    expect(artifact.summary).toBeDefined()
    expect(artifact.checks).toBeDefined()
    expect(Array.isArray(artifact.checks)).toBe(true)
    const checks = artifact.checks as ArtifactCheck[]
    const summary = artifact.summary as { passed: number; failed: number; total: number }
    // The run's own counts still agree with the run's own rows.
    expect(summary.total).toBe(checks.length)
    expect(summary.passed + summary.failed).toBe(summary.total)
    for (const check of checks) {
      expect(typeof check.id).toBe('string')
      expect(typeof check.expected).toBe('string')
      expect(typeof check.actual).toBe('string')
      expect(typeof check.ok).toBe('boolean')
    }
  })

  test.skipIf(!evidenceExists)('carries a provenance block that describes it', () => {
    const artifact = readArtifact()
    const provenance = artifact.evidenceProvenance
    expect(provenance).toBeDefined()
    if (!provenance) return
    // The block is an annotation, and it says the run is historical.
    expect(provenance.runIsHistorical).toBe(true)
    expect(typeof provenance.note).toBe('string')
    expect((provenance.note ?? '').length).toBeGreaterThan(0)
    expect(typeof provenance.publishedAt).toBe('string')
    expect(typeof provenance.runPredates).toBe('string')
    // The row counts it states are the ones that are true of the artifact.
    const checks = artifact.checks as ArtifactCheck[]
    expect(provenance.artifactRows).toBe(checks.length)
    expect(provenance.sourcePlannedRows).toBe(plannedRows().length)
    // The run did not pass: the artifact says so, and the block does not
    // claim otherwise.
    expect((artifact.summary as { ok: boolean }).ok).toBe(false)
  })

  test.skipIf(!evidenceExists)(
    'names exactly the rows the source plans and it does not carry',
    () => {
      const artifact = readArtifact()
      const provenance = artifact.evidenceProvenance
      expect(provenance).toBeDefined()
      if (!provenance) return
      const carried = new Set((artifact.checks as ArtifactCheck[]).map((check) => check.id))
      const missing = plannedRows().filter((id) => !carried.has(id))
      // The block's list is the real difference, not a remembered one: if the
      // source's rows change, this fails until the block is updated.
      expect([...(provenance.rowsInSourceNotInArtifact ?? [])].toSorted()).toEqual(missing)
      // The artifact's rows are a subset of the source's rows: the artifact
      // never claims a row the source cannot produce.
      for (const id of carried) expect(plannedRows()).toContain(id)
      // No committed revision of the source emits this row set, so the block
      // says the run came from a working state that was never committed.
      expect(provenance.sourceRevisionMatch?.matches).toBe(false)
      expect((provenance.sourceRevisionMatch?.detail ?? '').length).toBeGreaterThan(0)
    }
  )
})

describe('the published acceptance screenshots', () => {
  test.skipIf(!evidenceExists)('every capture the artifact names exists', () => {
    const artifact = readArtifact()
    const checks = artifact.checks as ArtifactCheck[]
    const named = checks.filter((check) => typeof check.screenshot === 'string')
    expect(named.length).toBeGreaterThan(0)
    for (const check of named) {
      expect(existsSync(join(screenshotDirectory, check.screenshot as string))).toBe(true)
    }
  })

  test.skipIf(!evidenceExists)('no two captures share an index', () => {
    const files = readdirSync(screenshotDirectory).filter((name) => name.endsWith('.png'))
    expect(files.length).toBeGreaterThan(0)
    const indexes = new Map<string, string>()
    for (const file of files) {
      const match = /^(\d+)-/.exec(file)
      if (!match) continue
      const index = match[1] as string
      expect(indexes.has(index)).toBe(false)
      indexes.set(index, file)
    }
  })

  test.skipIf(!evidenceExists)(
    'every capture is named by the artifact or is labelled an earlier capture',
    () => {
      const artifact = readArtifact()
      const checks = artifact.checks as ArtifactCheck[]
      const named = new Set(
        checks
          .filter((check) => typeof check.screenshot === 'string')
          .map((c) => c.screenshot as string)
      )
      const files = readdirSync(screenshotDirectory).filter((name) => name.endsWith('.png'))
      for (const file of files) {
        if (named.has(file)) continue
        // A file the artifact does not name is only allowed to stay when it is
        // labelled as an earlier capture, so a leftover can never masquerade as
        // the run's own capture.
        expect(file.startsWith('earlier-capture-')).toBe(true)
      }
      // Every capture the artifact names is in the directory.
      for (const file of named) expect(files).toContain(file)
    }
  )
})
