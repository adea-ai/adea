import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Helpers for the #1222 cutover rehearsal. Kept out of the `.test.ts` file so the
// strictness and disposal rules can be tested directly, without a database.

export const CUTOVER_TAG = '0046_artifact_reference_grants'
export const DRIZZLE_DIR = `${import.meta.dir}/../../drizzle`

/**
 * The product messages that mean "this principal may not see that resource" on the read
 * paths this rehearsal calls. The product answers "unavailable" for both a missing row and
 * an unauthorized one, so these two cases share a message by design; the rehearsal
 * separates them with positive controls (see the denial test). Anything else thrown from a
 * read (connection loss, a missing relation, a programming error) is not a denial and
 * must fail the rehearsal.
 */
export const PRODUCT_DENIALS: ReadonlySet<string> = new Set([
  'Channel unavailable',
  'Conversation participant unavailable',
  'Message unavailable',
  'Project unavailable',
  'Read state unavailable',
  'Task unavailable',
  'Workspace unavailable',
])

export function isProductDenial(error: unknown): boolean {
  return error instanceof Error && PRODUCT_DENIALS.has(error.message)
}

/** A principal-scoped read: a product denial becomes the value `denied`; any other error propagates. */
export async function view<T>(read: () => Promise<T>): Promise<T | 'denied'> {
  try {
    return await read()
  } catch (error) {
    if (isProductDenial(error)) return 'denied'
    throw error
  }
}

type Journal = { entries: { idx: number; tag: string }[]; dialect: string; version: string }

export function readJournal(): Journal {
  return JSON.parse(readFileSync(`${DRIZZLE_DIR}/meta/_journal.json`, 'utf8')) as Journal
}

/** The journal entries before `tag`, with their SQL copied verbatim, as a migrations folder. */
export function migrationsFolderBefore(tag: string): string {
  const journal = readJournal()
  const cut = journal.entries.findIndex((entry) => entry.tag === tag)
  if (cut < 0) throw new Error(`cutover tag ${tag} is not in the journal`)
  const folder = mkdtempSync(join(tmpdir(), 'rehearsal-1222-pre-'))
  mkdirSync(join(folder, 'meta'))
  const kept = journal.entries.slice(0, cut)
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries: kept })
  )
  for (const entry of kept) {
    copyFileSync(`${DRIZZLE_DIR}/${entry.tag}.sql`, join(folder, `${entry.tag}.sql`))
  }
  return folder
}

export type RehearsalResources = {
  connection?: { close(): Promise<void> }
  scratch?: string
  preFolder?: string
}

/**
 * Release everything the rehearsal owns. Every step is attempted even when an earlier
 * one fails, so the scratch database is still dropped if closing the connection fails and
 * the temporary folder is removed even if the drop fails. Failures are never swallowed:
 * they are collected and thrown together.
 */
export async function disposeRehearsal(
  resources: RehearsalResources,
  dropScratch: (database: string) => Promise<void>
): Promise<void> {
  const failures: unknown[] = []
  const attempt = async (step: () => Promise<void> | void) => {
    try {
      await step()
    } catch (error) {
      failures.push(error)
    }
  }
  if (resources.connection) await attempt(() => resources.connection!.close())
  if (resources.scratch) {
    const database = resources.scratch
    await attempt(() => dropScratch(database))
  }
  if (resources.preFolder) {
    const folder = resources.preFolder
    await attempt(() => rmSync(folder, { recursive: true, force: true }))
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `rehearsal cleanup failed in ${failures.length} step(s)`)
  }
}
