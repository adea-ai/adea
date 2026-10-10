import { createHash } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DRIZZLE_DIR, readJournal } from './cutover-rehearsal'

// The incoming canonical migration chain for the #1241 rehearsal: main through 0046, then the
// approved order #1229 -> #1230 -> #1232. Every entry is vendored verbatim from its exact source
// commit (see pins.json). Nothing here rewrites a timestamp: if a pinned `when` is out of order,
// the rehearsal fails on it rather than repairing it.

export const CANONICAL_DIR = `${import.meta.dir}/canonical-chain`
export const CANONICAL_BASE_TAG = '0046_artifact_reference_grants'
/** How many canonical entries a database holds once #1229 and #1230 have landed. */
const STAGE_ONE_COUNT = 2

export type JournalEntry = {
  idx: number
  version: string
  when: number
  tag: string
  breakpoints: boolean
}

export type CanonicalPins = {
  base: { branch: string; commit: string; lastTag: string }
  order: string[]
  files: Record<
    string,
    {
      sha256: string
      sourcePullRequest: number
      sourceHeadSha: string
      sourcePath: string
      when: number
      idx: number
    }
  >
  journalSha256: string
  excluded: {
    tag: string
    sha256: string
    sourcePullRequest: number
    sourceHeadSha: string
    reason: string
  }[]
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

/** The vendored canonical chain must match its pins exactly; a drifted or extra file fails first. */
export function verifiedCanonicalChain(): { pins: CanonicalPins; entries: JournalEntry[] } {
  const pins = JSON.parse(readFileSync(`${CANONICAL_DIR}/pins.json`, 'utf8')) as CanonicalPins
  const journal = readFileSync(`${CANONICAL_DIR}/_journal.json`)
  if (sha256(journal) !== pins.journalSha256) {
    throw new Error('canonical-chain _journal.json does not match its pin')
  }
  for (const [name, pin] of Object.entries(pins.files)) {
    if (sha256(readFileSync(`${CANONICAL_DIR}/${name}`)) !== pin.sha256) {
      throw new Error(`canonical-chain ${name} does not match its pin`)
    }
  }
  const onDisk = readdirSync(CANONICAL_DIR)
    .filter((name) => name.endsWith('.sql'))
    .toSorted()
  if (onDisk.join() !== Object.keys(pins.files).toSorted().join()) {
    throw new Error('canonical-chain holds a migration that is not pinned')
  }
  for (const excluded of pins.excluded) {
    if (onDisk.includes(`${excluded.tag}.sql`)) {
      throw new Error(`canonical-chain holds excluded migration ${excluded.tag}`)
    }
  }
  const entries = (JSON.parse(journal.toString('utf8')) as { entries: JournalEntry[] }).entries
  if (entries.map((entry) => entry.tag).join() !== pins.order.join()) {
    throw new Error('canonical-chain journal order does not match the pinned order')
  }
  return { pins, entries }
}

/**
 * Drizzle applies a journal entry only when its `when` is later than the newest row already
 * recorded. An entry that is not later than its predecessor is therefore skipped silently on any
 * database that already holds the predecessor. Returns every such ordering violation.
 */
export function timestampOrderViolations(entries: { tag: string; when: number }[]): string[] {
  const violations: string[] = []
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1]!
    const current = entries[index]!
    if (current.when <= previous.when) {
      violations.push(
        `${current.tag} (when ${current.when}) does not follow ${previous.tag} (when ${previous.when})`
      )
    }
  }
  return violations
}

export type CanonicalChainFolders = {
  /** Main plus #1229 and #1230: the state a database holds before #1232 lands. */
  stageOne: string
  /** Main plus the whole canonical chain, in the approved order. */
  full: string
  /** Every journal entry of `full`, in order, for comparison against the recorded migrations. */
  fullEntries: { tag: string; when: number }[]
  /** Removes both folders. */
  root: string
}

/**
 * Assembles the canonical chain on top of the live main journal, which must end exactly at the
 * pinned base. A main that has advanced fails here, so the chain is re-pinned deliberately rather
 * than appended to a journal it no longer follows.
 */
export function canonicalChainFolders(): CanonicalChainFolders {
  const { entries: canonical } = verifiedCanonicalChain()
  // The shared Journal type omits `when`; the runtime entries carry it, and the ordering checks need it.
  const live = readJournal() as unknown as {
    dialect: string
    version: string
    entries: JournalEntry[]
  }
  const lastMainTag = live.entries.at(-1)?.tag
  if (lastMainTag !== CANONICAL_BASE_TAG) {
    throw new Error(
      `main's journal ends at ${lastMainTag}, not ${CANONICAL_BASE_TAG}. Main has advanced, so the canonical chain must be re-pinned against main's new head before this rehearsal can run.`
    )
  }

  const root = mkdtempSync(join(tmpdir(), 'rehearsal-canonical-'))
  const assemble = (name: string, chain: JournalEntry[]): string => {
    const folder = join(root, name)
    const entries = [...live.entries, ...chain]
    const tags = entries.map((entry) => entry.tag)
    if (new Set(tags).size !== tags.length) {
      throw new Error(`assembled ${name} journal repeats a migration tag`)
    }
    mkdirSync(join(folder, 'meta'), { recursive: true })
    writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...live, entries }))
    for (const entry of live.entries) {
      copyFileSync(`${DRIZZLE_DIR}/${entry.tag}.sql`, join(folder, `${entry.tag}.sql`))
    }
    for (const entry of chain) {
      copyFileSync(`${CANONICAL_DIR}/${entry.tag}.sql`, join(folder, `${entry.tag}.sql`))
    }
    return folder
  }

  return {
    stageOne: assemble('stage-one', canonical.slice(0, STAGE_ONE_COUNT)),
    full: assemble('full', canonical),
    fullEntries: [...live.entries, ...canonical].map((entry) => ({
      tag: entry.tag,
      when: entry.when,
    })),
    root,
  }
}
