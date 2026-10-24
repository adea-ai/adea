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
//     explicitly labelled as an earlier capture;
//   - the approved captures still carry their approved bytes, so a quiet
//     re-render cannot pass unnoticed and cannot be used to make a check pass;
//   - the record carries the captures' base and the source surface they depend
//     on, so a stale capture is answerable from the evidence alone.
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
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
const recordPath = join(root, 'docs', 'evidence', 'installed-desktop-ui-acceptance-2026-10-20.md')

/**
 * The approved captures, by content. Each one is what the recorded run
 * produced, so a different hash means the capture was re-rendered — which is
 * only legitimate in a deliberate commit that updates this table too.
 */
const APPROVED_CAPTURES: Readonly<Record<string, string>> = {
  '01-first-run.png': '941a3e22ab44183b4e5a233626df4dc07ffb6e880ddbc1c1e74beb235b2fde48',
  '02-chat-view.png': '17043af7eca44c8f65e48918d3576bd0f61f215f82c8212ba239d8c861e2a079',
  '03-dev-view.png': '42cdfd574dea834aa0c4c3ea711974a0febd605cf96ea85784931e34fbe15a38',
  '04-app-library.png': 'c299a4d25b2c3e4e0c2a0bfd0dfe2f9582d11d875cf5da4eb99dec2654134fe5',
  '05-app-library-defaults.png': 'c299a4d25b2c3e4e0c2a0bfd0dfe2f9582d11d875cf5da4eb99dec2654134fe5',
  '06-app-library-optional.png': 'c299a4d25b2c3e4e0c2a0bfd0dfe2f9582d11d875cf5da4eb99dec2654134fe5',
  '07-back-forward.png': 'fcf040732ae55f03bd889ca1aedbf487567f3a9eadaa30e71e173ccfb561ad88',
  '08-repeated-navigation.png': 'adf24d342fd7b36b6f11cf933779a61502e4c480244d3f938b89647097732d3e',
  '09-interrupted-navigation.png':
    '42cdfd574dea834aa0c4c3ea711974a0febd605cf96ea85784931e34fbe15a38',
  '10-reload.png': 'ca58e53092fb4ce019728f3a7bec97b9ce800d11fc0eb16c9a7d5cbdbdd06775',
  'earlier-capture-09-reload.png':
    '23200e4579aa7676db32e0d3c1b607729877613ecfe8e1487ba6dee17a87368e',
}

/** The candidate's integration base: the source the captures were taken from. */
const CAPTURE_BASE = '333b948d4c5fba1f88d98d764c075b790be6ee22'

/** The source surface the captured views are rendered by. */
const RENDERING_SURFACE = [
  'apps/web/src/components/workspace-entry.tsx',
  'apps/web/src/components/workspace-navigation.tsx',
  'apps/web/src/start/routes/index.tsx',
  'packages/workspace-ui/src/conversation-surface.tsx',
  'packages/workspace-ui/src/app-library-page.tsx',
  'packages/workspace-ui/src/workspace-states.tsx',
  'packages/dev-view/src/dev-workspace-entry.tsx',
  'apps/web/src/lib/account-directory.ts',
] as const

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

describe('the approved captures are pinned', () => {
  test('every approved capture still carries its approved bytes', () => {
    // A capture is evidence, not a baseline to refresh: each one is what the
    // recorded run produced. A different hash means the capture was
    // re-rendered, which is only legitimate in a deliberate commit that
    // updates this table with it. A regeneration performed to make a check
    // pass is a defect, and this case fails it.
    const files = readdirSync(screenshotDirectory).filter((name) => name.endsWith('.png'))
    for (const [name, sha256] of Object.entries(APPROVED_CAPTURES)) {
      const file = join(screenshotDirectory, name)
      expect(existsSync(file)).toBe(true)
      const digest = createHash('sha256').update(readFileSync(file)).digest('hex')
      expect(digest).toBe(sha256)
    }
    // A capture that is not in the approved set is a new one, and it has to
    // be deliberate: it is named here before it can count as evidence.
    for (const file of files) {
      expect(Object.keys(APPROVED_CAPTURES)).toContain(file)
    }
  })

  test("the record carries the captures' base and the surface they depend on", () => {
    // Without these, "is the approved capture still valid?" cannot be
    // answered from the evidence at all: a reviewer would have to guess which
    // source produced it.
    const record = readFileSync(recordPath, 'utf8')
    expect(record).toContain(CAPTURE_BASE)
    for (const path of RENDERING_SURFACE) {
      expect(record).toContain(path)
    }
  })
})
