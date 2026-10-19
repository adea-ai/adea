#!/usr/bin/env node
// The cross-machine and cross-platform transfer qualification for the shared task cache transport.
//
// This module qualifies one question per pair of machines: may the cache entry that machine A wrote be replayed by
// machine B? It qualifies that question with the implemented transport, against an injected store, with synthetic
// entries. It never opens a connection, reads a credential or contacts a service.
//
// ## What a machine is
//
// A machine is a **trust domain**: a namespace (the repository or tenant the entries belong to), the pinned client
// version and the pinned toolchain identity. The toolchain identity is what carries the platform. In this repository
// the toolchain id has the shape
//
//   <platform>-<arch>.<libc>.node<version>-<sha>.bun<version>-<sha>
//
// (scripts/orch-toolchain.mjs), and it holds a version and a hash of each binary, the platform and the libc, but
// **never a path**: the same bytes at another path (another checkout, another runner) keep their entries.
//
// So the qualification's boundaries follow from that:
//
//   - two machines with the same namespace, the same client and the same toolchain id are the **same domain**, even
//     when they are different checkouts on different disks. An entry transfers between them and is replayed;
//   - a machine with a different platform, architecture, libc or runtime has a **different toolchain id** and is a
//     different domain. Its entries are not shared, and an entry that is handed to it is refused. The transport does
//     not carry a build across platforms, and it does not pretend to;
//   - a machine with a different client version, or a different namespace, is a different domain for the same
//     reason.
//
// ## What the qualification does
//
// `qualifyTransfer` publishes a synthetic entry from the source machine, reads it back as the target machine, and
// reports what the target may do with it. It also reports the **transfer identity** of the envelope: the digest of the
// canonical envelope bytes with the recorded creation time blanked. That identity depends only on the entry bytes and
// the trust domain, so it is the same on every machine of the domain and it shows that the envelope encoding carries
// nothing of the machine that wrote it - no path, no locale, no clock beyond the creation time it records.
//
// The qualification is offline and synthetic. It proves what the implemented contract does; it does not claim that any
// task cache is portable in general, and it does not stand in for the client's own export and import, which do not
// exist (see docs/evidence/vp-r2-cache-transport-2026-10-19.md).
import { createHash } from 'node:crypto'

import {
  CATEGORY,
  DEFAULT_DEADLINE_MS,
  LIMITS,
  canonicalEnvelopeBytes,
  entryObjectKey,
  lookupEntry,
  parseEnvelope,
  publishEntry,
  readBlob,
  trustDomain,
} from './vp-r2-cache.mjs'

/** The placeholder the transfer identity uses for the recorded creation time. */
const TIME_PLACEHOLDER = '1970-01-01T00:00:00.000Z'

/** The shape of the repository's toolchain id, so the fixtures name the platforms the way the build does. */
export function toolchainId({ platform, arch, libc, node, bun, nodeSha, bunSha }) {
  return [
    `${platform}-${arch}`,
    libc,
    `node${node.replace(/^v/, '')}-${nodeSha.slice(0, 12)}`,
    `bun${bun.replace(/^v/, '')}-${bunSha.slice(0, 12)}`,
  ].join('.')
}

/**
 * A machine profile: what the transport needs to know about the machine an entry belongs to, and the trust domain
 * that follows from it.
 */
export function machine({ namespace, client, toolchain, platform, arch }) {
  const scope = trustDomain({ namespace, client, toolchain })
  return { namespace, client, toolchain, platform, arch, scope }
}

/**
 * The identity of an envelope for transfer: the digest of its canonical bytes with the recorded creation time
 * blanked. Two envelopes of the same entry and the same trust domain have the same identity on every machine, so the
 * identity can be compared across machines and across checkouts.
 */
export function transferIdentity(envelope) {
  const bytes = canonicalEnvelopeBytes({ ...envelope, created_at: TIME_PLACEHOLDER })
  return createHash('sha256').update(bytes).digest('hex')
}

/** The digest of a set of bytes. */
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** The object keys a store holds, when the store can list them. `null` when it cannot. */
export function listedKeys(store) {
  const keys = store.objects?.keys?.()
  return keys ? [...keys] : null
}

/**
 * Awaits a promise until the deadline, and gives up when the caller's signal is aborted. A promise that does not
 * answer in time ends the wait; the promise itself is left to settle on its own.
 */
function withDeadline(promise, { deadlineMs, signal }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deadlineMs)
  timer.unref?.()
  const forward = () => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', forward, { once: true })
  const guard = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('the deadline passed')), {
      once: true,
    })
  })
  return Promise.race([Promise.resolve(promise), guard]).finally(() => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
  })
}

/**
 * Reads the envelope that was stored and validates it under a trust domain. The read is bounded by `maxBytes` and by
 * the deadline that is left, and it carries the caller's signal, so a store that rejects the read or never answers
 * ends the read instead of the qualification.
 *
 * The result is the validated envelope, or the category it was refused for. It is never an exception.
 */
export async function readStoredEnvelope(
  store,
  entryKey,
  domain,
  { maxBytes = LIMITS.maxEnvelopeBytes, deadlineMs = DEFAULT_DEADLINE_MS, signal } = {}
) {
  if (entryKey === undefined) return { refusedWith: CATEGORY.notFound }
  let bytes
  try {
    bytes = await withDeadline(store.get(entryKey, { maxBytes, signal }), { deadlineMs, signal })
  } catch {
    return { refusedWith: CATEGORY.storeRead }
  }
  if (bytes === null || bytes === undefined) return { refusedWith: CATEGORY.notFound }
  try {
    return { envelope: parseEnvelope(Buffer.from(bytes), { scope: domain.scope }) }
  } catch (error) {
    return { refusedWith: error.category ?? CATEGORY.invalidEnvelope }
  }
}

/**
 * Reads the envelope that was published, as the target machine would read it, and reports the category it was
 * refused for. A target that shares the domain reads it; a target that does not is refused, and the refusal says
 * whether the entry belonged to another trust domain or to another client and toolchain.
 */
export async function readAsTarget(
  store,
  entryKey,
  target,
  { maxBytes = LIMITS.maxEnvelopeBytes, deadlineMs = DEFAULT_DEADLINE_MS, signal } = {}
) {
  const read = await readStoredEnvelope(store, entryKey, target, { maxBytes, deadlineMs, signal })
  return { refusedWith: read.envelope ? null : read.refusedWith }
}

/**
 * Runs one transfer qualification: the source machine publishes a synthetic entry, and the target machine reads it
 * back. The result says whether the target may replay the entry, and when it may not, which category refused it.
 *
 * `publish: false` qualifies an entry that is already in the store, without writing it again. That is how a store
 * that was changed under the transport is qualified.
 *
 * The result is a report, never an exception: a refused or failed transfer is a result, and the target keeps its local
 * cache.
 */
export async function qualifyTransfer({
  store,
  entry,
  from,
  to,
  limits,
  deadlineMs,
  createdAt = '2026-10-19T00:00:00.000Z',
  publish = true,
}) {
  const budget = Date.now() + (deadlineMs ?? DEFAULT_DEADLINE_MS)
  const remaining = () => Math.max(0, budget - Date.now())
  const written = publish
    ? await publishEntry(store, entry, { scope: from.scope, limits, deadlineMs, createdAt })
    : { ok: false, skipped: true, category: null, envelope: null, entryKey: undefined }
  const entryKey = written.entryKey ?? entryObjectKey(from.scope, entry.key, entry.secondaryKey)
  // The envelope the report is built from is the **stored** one, read back and validated under the domain that wrote
  // it. It is never reconstructed from the expected input: a store that holds a different entry under the same key
  // must be reported as such.
  const stored = await readStoredEnvelope(store, entryKey, from, {
    maxBytes: limits?.maxEnvelopeBytes ?? LIMITS.maxEnvelopeBytes,
    deadlineMs: remaining(),
  })
  const envelope = stored.envelope ?? null
  const found = await lookupEntry(
    store,
    { key: entry.key, secondaryKey: entry.secondaryKey },
    { scope: to.scope, limits, deadlineMs }
  )
  const blob = found.ok
    ? await readBlob(store, found.envelope.blob_id, { scope: to.scope, limits, deadlineMs })
    : null
  const keys = listedKeys(store)
  const staged = (keys ?? []).filter((name) => name.startsWith('staging/'))
  const publishedObjects = (keys ?? []).filter((name) => name.startsWith('entries/'))
  // Every byte of the entry is compared: the entry key, the task fingerprint key, the entry value and the archive.
  const entryIdentical =
    envelope !== null &&
    envelope.keyBytes.equals(entry.key) &&
    envelope.secondaryKeyBytes.equals(entry.secondaryKey) &&
    envelope.valueBytes.equals(entry.value) &&
    blob?.ok === true &&
    Buffer.from(blob.bytes).equals(entry.blob)
  const replayable = found.ok && entryIdentical
  const handed = await readAsTarget(store, entryKey, to, {
    maxBytes: limits?.maxEnvelopeBytes ?? LIMITS.maxEnvelopeBytes,
    deadlineMs: remaining(),
  })
  return {
    from: {
      namespace: from.namespace,
      client: from.client,
      toolchain: from.toolchain,
      platform: from.platform,
      arch: from.arch,
      domain: from.scope.id,
    },
    to: {
      namespace: to.namespace,
      client: to.client,
      toolchain: to.toolchain,
      platform: to.platform,
      arch: to.arch,
      domain: to.scope.id,
    },
    sameDomain: from.scope.id === to.scope.id,
    published: written.ok === true,
    publishSkipped: written.skipped === true,
    publishCategory: written.ok ? null : written.category,
    replayable,
    refusedWith: found.ok ? null : found.category,
    blobRefusedWith: blob?.ok === true ? null : (blob?.category ?? null),
    envelopeRefusedWith: handed.refusedWith,
    storedRefusedWith: stored.refusedWith ?? null,
    // The identity of the **stored** envelope, not of the expected input.
    transferIdentity: envelope === null ? null : transferIdentity(envelope),
    entryIdentical,
    valueIdentical: envelope === null ? null : envelope.valueBytes.equals(entry.value),
    archiveSha256: digest(entry.blob),
    archiveIdentical: entryIdentical,
    stagedObjects: staged,
    publishedObjects,
  }
}

/**
 * Runs the qualification over every ordered pair of a set of machines and returns one row per pair. The rows are what
 * the evidence document records: which pairs may share an entry, and which are refused and why.
 *
 * Every pair is qualified on a **fresh store**: a pair must not see what another pair wrote, or a target would find an
 * entry that another machine published and the boundary would not be measured.
 */
export async function qualifyMatrix({ newStore, entry, machines, limits, deadlineMs }) {
  const rows = []
  for (const from of machines) {
    for (const to of machines) {
      rows.push(await qualifyTransfer({ store: newStore(), entry, from, to, limits, deadlineMs }))
    }
  }
  return rows
}
