// RuntimeNode registration, pairing, proofs, rotation, and revocation.
//
// Agent HQ owns the record; the node owns the private keys. Everything here
// stores or reads *public* material and pairing state, and every state change
// that a node performs is proven by a signature over a single-use challenge.

import { createHash } from 'node:crypto'

import { and, asc, desc, eq, inArray, isNull, lt } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { appendWorkspaceEvent } from './transactions'
import {
  runtimeNodeChallenges,
  runtimeNodeExchangeCredentials,
  runtimeNodeKeys,
  runtimeNodes,
} from './schema'
import type { JsonObject } from './schema'
import { inTransaction } from './transactions'

export type RuntimeNodeKindValue = 'local_device' | 'remote_host'
export type RuntimeNodeKeyRoleValue = 'signing' | 'command_encryption'
export type RuntimeNodeKeyAlgorithmValue = 'ed25519' | 'x25519'
export type RuntimeNodeChallengePurposeValue = 'pair' | 'rotate' | 'proof'

export const PAIRING_CHALLENGE_LIFETIME_MS = 10 * 60 * 1_000
export const PROOF_CHALLENGE_LIFETIME_MS = 2 * 60 * 1_000
export const EXCHANGE_CREDENTIAL_LIFETIME_MS = 10 * 60 * 1_000
/** A node whose last proof is older than this reads as stale rather than healthy. */
export const RUNTIME_NODE_STALE_AFTER_MS = 5 * 60 * 1_000

export class RuntimeNodeError extends Error {
  constructor(
    readonly code:
      | 'challenge_expired'
      | 'challenge_used'
      | 'conflict'
      | 'exchange_credential_invalid'
      | 'invalid'
      | 'key_mismatch'
      | 'not_found'
      | 'revoked'
      | 'unauthorized',
    message: string
  ) {
    super(message)
    this.name = 'RuntimeNodeError'
  }
}

/** The product read model. Public material only: no private keys, no endpoints. */
export type RuntimeNodeView = Readonly<{
  displayName: string
  health: 'healthy' | 'stale' | 'unknown'
  id: string
  keys: ReadonlyArray<
    Readonly<{
      algorithm: RuntimeNodeKeyAlgorithmValue
      fingerprint: string
      keyVersion: number
      publicKey: string
      retiredAt: string | null
      role: RuntimeNodeKeyRoleValue
      verifiedAt: string | null
    }>
  >
  kind: RuntimeNodeKindValue
  lastProofAt: string | null
  lastSeenAt: string | null
  pairedAt: string
  pairingState: 'paired' | 'revoked'
  platform: string
  revocationReason: string | null
  revokedAt: string | null
  softwareVersion: string
  trustMetadata: JsonObject
}>

export type RuntimeNodeKeyInput = Readonly<{
  algorithm: RuntimeNodeKeyAlgorithmValue
  publicKey: string
  role: RuntimeNodeKeyRoleValue
}>

/** Every failure a rotated, revoked, or foreign node hits is reported identically. */
async function requireNode(
  database: AgentHqDatabase | AgentHqTransaction,
  workspaceId: string,
  runtimeNodeId: string
) {
  const [node] = await database
    .select()
    .from(runtimeNodes)
    .where(and(eq(runtimeNodes.id, runtimeNodeId), eq(runtimeNodes.workspaceId, workspaceId)))
  if (!node) throw new RuntimeNodeError('not_found', 'Runtime node unavailable')
  return node
}

function assertKeyRoleMatchesAlgorithm(
  role: RuntimeNodeKeyRoleValue,
  algorithm: RuntimeNodeKeyAlgorithmValue
): void {
  const expected = role === 'signing' ? 'ed25519' : 'x25519'
  if (algorithm !== expected) {
    throw new RuntimeNodeError(
      'key_mismatch',
      `A ${role} key must be ${expected}; refusing to register ${algorithm}`
    )
  }
}

/**
 * Open a short-lived, single-use challenge for one purpose. The nonce is what
 * the node signs; binding it to a purpose, kind, workspace, and audience is what
 * stops a captured signature from being replayed somewhere else.
 */
export async function createRuntimeNodeChallenge(
  database: AgentHqDatabase,
  input: Readonly<{
    audience: string
    createdByUserId: string
    kind: RuntimeNodeKindValue
    nonce: string
    purpose: RuntimeNodeChallengePurposeValue
    runtimeNodeId?: string | null
    workspaceId: string
  }>
): Promise<Readonly<{ challengeId: string; expiresAt: Date; nonce: string }>> {
  const lifetime =
    input.purpose === 'pair' ? PAIRING_CHALLENGE_LIFETIME_MS : PROOF_CHALLENGE_LIFETIME_MS
  const expiresAt = new Date(Date.now() + lifetime)
  const [challenge] = await database
    .insert(runtimeNodeChallenges)
    .values({
      audience: input.audience,
      createdByUserId: input.createdByUserId,
      expiresAt,
      kind: input.kind,
      nonce: input.nonce,
      purpose: input.purpose,
      runtimeNodeId: input.runtimeNodeId ?? null,
      workspaceId: input.workspaceId,
    })
    .returning({ expiresAt: runtimeNodeChallenges.expiresAt, id: runtimeNodeChallenges.id })
  if (!challenge) throw new RuntimeNodeError('invalid', 'Challenge could not be created')
  return { challengeId: challenge.id, expiresAt: challenge.expiresAt, nonce: input.nonce }
}

/**
 * Consume a challenge exactly once, inside a transaction. A second consumption,
 * an expired challenge, or a mismatched purpose/kind/node is refused with names
 * the caller can act on.
 */
export async function consumeRuntimeNodeChallenge(
  transaction: AgentHqTransaction,
  input: Readonly<{
    challengeId: string
    kind: RuntimeNodeKindValue
    purpose: RuntimeNodeChallengePurposeValue
    runtimeNodeId?: string | null
    workspaceId: string
  }>
) {
  const [challenge] = await transaction
    .select()
    .from(runtimeNodeChallenges)
    .where(
      and(
        eq(runtimeNodeChallenges.id, input.challengeId),
        eq(runtimeNodeChallenges.workspaceId, input.workspaceId)
      )
    )
  if (!challenge) throw new RuntimeNodeError('not_found', 'Pairing challenge unavailable')
  if (challenge.consumedAt) throw new RuntimeNodeError('challenge_used', 'Challenge already used')
  if (challenge.purpose !== input.purpose || challenge.kind !== input.kind) {
    throw new RuntimeNodeError('invalid', 'Challenge does not match this request')
  }
  if ((challenge.runtimeNodeId ?? null) !== (input.runtimeNodeId ?? null)) {
    throw new RuntimeNodeError('invalid', 'Challenge does not match this runtime node')
  }
  if (challenge.expiresAt.getTime() <= Date.now()) {
    throw new RuntimeNodeError('challenge_expired', 'Challenge expired')
  }

  const [consumed] = await transaction
    .update(runtimeNodeChallenges)
    .set({ consumedAt: new Date() })
    .where(
      and(eq(runtimeNodeChallenges.id, challenge.id), isNull(runtimeNodeChallenges.consumedAt))
    )
    .returning({ id: runtimeNodeChallenges.id, nonce: runtimeNodeChallenges.nonce })
  if (!consumed) throw new RuntimeNodeError('challenge_used', 'Challenge already used')
  return consumed
}

/**
 * Register a node from a verified proof, or resume the node that already holds
 * this signing key. Resuming rather than duplicating is what makes a desktop
 * restart recover the same identity.
 */
export async function registerRuntimeNode(
  database: AgentHqDatabase,
  input: Readonly<{
    challengeId: string
    displayName: string
    keys: readonly RuntimeNodeKeyInput[]
    kind: RuntimeNodeKindValue
    ownerUserId: string
    platform: string
    softwareVersion: string
    trustMetadata?: JsonObject
    workspaceId: string
  }>
): Promise<RuntimeNodeView> {
  for (const key of input.keys) assertKeyRoleMatchesAlgorithm(key.role, key.algorithm)
  const signing = input.keys.find((key) => key.role === 'signing')
  const encryption = input.keys.find((key) => key.role === 'command_encryption')
  if (!signing || !encryption) {
    throw new RuntimeNodeError(
      'invalid',
      'A runtime node registers both a signing key and a separate command-encryption key'
    )
  }
  if (signing.publicKey === encryption.publicKey) {
    throw new RuntimeNodeError('key_mismatch', 'Signing and encryption keys must be distinct')
  }

  return inTransaction(database, async (transaction) => {
    const challenge = await consumeRuntimeNodeChallenge(transaction, {
      challengeId: input.challengeId,
      kind: input.kind,
      purpose: 'pair',
      workspaceId: input.workspaceId,
    })

    const matching = await transaction
      .select({ node: runtimeNodes })
      .from(runtimeNodeKeys)
      .innerJoin(runtimeNodes, eq(runtimeNodeKeys.runtimeNodeId, runtimeNodes.id))
      .where(
        and(
          eq(runtimeNodes.workspaceId, input.workspaceId),
          eq(runtimeNodes.kind, input.kind),
          eq(runtimeNodeKeys.role, 'signing'),
          isNull(runtimeNodeKeys.retiredAt),
          eq(runtimeNodeKeys.fingerprint, fingerprintOf(signing.publicKey))
        )
      )
      .limit(1)
    const existing = matching[0]?.node

    if (existing) {
      if (existing.pairingState === 'revoked') {
        throw new RuntimeNodeError('revoked', 'Runtime node was revoked; pair it again')
      }
      const now = new Date()
      await transaction
        .update(runtimeNodes)
        .set({
          displayName: input.displayName,
          lastProofAt: now,
          lastSeenAt: now,
          platform: input.platform,
          softwareVersion: input.softwareVersion,
          trustMetadata: input.trustMetadata ?? {},
          updatedAt: now,
        })
        .where(eq(runtimeNodes.id, existing.id))
      await upsertVerifiedKeys(transaction, existing.id, input.keys)
      await appendWorkspaceEvent(transaction, {
        eventType: 'runtime_node.proof_accepted',
        payload: {
          actorUserId: input.ownerUserId,
          challengeId: challenge.id,
          runtimeNodeId: existing.id,
        },
        workspaceId: input.workspaceId,
      })
      return readRuntimeNode(transaction, input.workspaceId, existing.id)
    }

    const now = new Date()
    const [node] = await transaction
      .insert(runtimeNodes)
      .values({
        displayName: input.displayName,
        kind: input.kind,
        lastProofAt: now,
        lastSeenAt: now,
        ownerUserId: input.ownerUserId,
        pairedAt: now,
        platform: input.platform,
        softwareVersion: input.softwareVersion,
        trustMetadata: input.trustMetadata ?? {},
        workspaceId: input.workspaceId,
      })
      .returning({ id: runtimeNodes.id })
    if (!node) throw new RuntimeNodeError('invalid', 'Runtime node could not be registered')

    await upsertVerifiedKeys(transaction, node.id, input.keys)
    await appendWorkspaceEvent(transaction, {
      eventType: 'runtime_node.paired',
      payload: {
        actorUserId: input.ownerUserId,
        challengeId: challenge.id,
        kind: input.kind,
        runtimeNodeId: node.id,
        signingKeyFingerprint: fingerprintOf(signing.publicKey),
      },
      workspaceId: input.workspaceId,
    })
    return readRuntimeNode(transaction, input.workspaceId, node.id)
  })
}

/**
 * Record the keys a node proved possession of. A key always arrives verified:
 * the caller has already checked a signature made with it.
 */
async function upsertVerifiedKeys(
  transaction: AgentHqTransaction,
  runtimeNodeId: string,
  keys: readonly RuntimeNodeKeyInput[]
): Promise<void> {
  for (const key of keys) {
    assertKeyRoleMatchesAlgorithm(key.role, key.algorithm)
    const fingerprint = fingerprintOf(key.publicKey)
    const [current] = await transaction
      .select({
        fingerprint: runtimeNodeKeys.fingerprint,
        id: runtimeNodeKeys.id,
        keyVersion: runtimeNodeKeys.keyVersion,
      })
      .from(runtimeNodeKeys)
      .where(
        and(
          eq(runtimeNodeKeys.runtimeNodeId, runtimeNodeId),
          eq(runtimeNodeKeys.role, key.role),
          isNull(runtimeNodeKeys.retiredAt)
        )
      )
      .orderBy(desc(runtimeNodeKeys.keyVersion))
      .limit(1)

    if (current?.fingerprint === fingerprint) {
      await transaction
        .update(runtimeNodeKeys)
        .set({ verifiedAt: new Date() })
        .where(eq(runtimeNodeKeys.id, current.id))
      continue
    }

    await transaction.insert(runtimeNodeKeys).values({
      algorithm: key.algorithm,
      fingerprint,
      keyVersion: (current?.keyVersion ?? 0) + 1,
      publicKey: key.publicKey,
      role: key.role,
      runtimeNodeId,
      verifiedAt: new Date(),
    })
    if (current) {
      // The replacement is verified and stored before the previous key is
      // retired, so a proof can never race the wire format it depends on.
      await transaction
        .update(runtimeNodeKeys)
        .set({ retiredAt: new Date() })
        .where(eq(runtimeNodeKeys.id, current.id))
    }
  }
}

/** Fingerprint of raw public-key bytes: the node's stable public identity. */
export function fingerprintOf(publicKey: string): string {
  return createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('base64url')
}

/**
 * Rotate a node's keys from a verified proof made with the *new* key. The old
 * key is retired only after the new one is stored and verified, and the public
 * record of the retired key stays so queued remote-command envelopes that
 * reference its version remain auditable.
 */
export async function rotateRuntimeNodeKeys(
  database: AgentHqDatabase,
  input: Readonly<{
    challengeId: string
    keys: readonly RuntimeNodeKeyInput[]
    ownerUserId: string
    runtimeNodeId: string
    workspaceId: string
  }>
): Promise<RuntimeNodeView> {
  return inTransaction(database, async (transaction) => {
    const node = await requireNode(transaction, input.workspaceId, input.runtimeNodeId)
    if (node.pairingState === 'revoked') {
      throw new RuntimeNodeError('revoked', 'Runtime node is revoked')
    }
    await consumeRuntimeNodeChallenge(transaction, {
      challengeId: input.challengeId,
      kind: node.kind,
      purpose: 'rotate',
      runtimeNodeId: node.id,
      workspaceId: input.workspaceId,
    })
    await upsertVerifiedKeys(transaction, node.id, input.keys)
    const now = new Date()
    await transaction
      .update(runtimeNodes)
      .set({ lastProofAt: now, lastSeenAt: now, updatedAt: now })
      .where(eq(runtimeNodes.id, node.id))
    await appendWorkspaceEvent(transaction, {
      eventType: 'runtime_node.key_rotated',
      payload: {
        actorUserId: input.ownerUserId,
        keyFingerprints: input.keys.map((key) => fingerprintOf(key.publicKey)),
        runtimeNodeId: node.id,
      },
      workspaceId: input.workspaceId,
    })
    return readRuntimeNode(transaction, input.workspaceId, node.id)
  })
}

/** Record a signed liveness proof: the node is alive and still holds its key. */
export async function recordRuntimeNodeProof(
  database: AgentHqDatabase,
  input: Readonly<{
    challengeId: string
    runtimeNodeId: string
    workspaceId: string
  }>
): Promise<Readonly<{ lastProofAt: Date | null; runtimeNodeId: string }>> {
  return inTransaction(database, async (transaction) => {
    const node = await requireNode(transaction, input.workspaceId, input.runtimeNodeId)
    if (node.pairingState === 'revoked') {
      throw new RuntimeNodeError('revoked', 'Runtime node is revoked')
    }
    await consumeRuntimeNodeChallenge(transaction, {
      challengeId: input.challengeId,
      kind: node.kind,
      purpose: 'proof',
      runtimeNodeId: node.id,
      workspaceId: input.workspaceId,
    })
    const now = new Date()
    await transaction
      .update(runtimeNodes)
      .set({ lastProofAt: now, lastSeenAt: now, updatedAt: now })
      .where(eq(runtimeNodes.id, node.id))
    return { lastProofAt: now, runtimeNodeId: node.id }
  })
}

/**
 * Revoke a node. New remote commands and relay payloads stop being eligible
 * immediately; nothing about the node's own local data, the workspace's
 * synchronized history, or any member's membership changes — those are governed
 * elsewhere.
 */
export async function revokeRuntimeNode(
  database: AgentHqDatabase,
  input: Readonly<{
    actorUserId: string
    reason: string
    runtimeNodeId: string
    workspaceId: string
  }>
): Promise<RuntimeNodeView> {
  const reason = input.reason.trim().slice(0, 200)
  if (!reason) throw new RuntimeNodeError('invalid', 'A revocation reason is required')
  return inTransaction(database, async (transaction) => {
    const node = await requireNode(transaction, input.workspaceId, input.runtimeNodeId)
    if (node.pairingState === 'revoked') {
      throw new RuntimeNodeError('revoked', 'Runtime node is already revoked')
    }
    const now = new Date()
    await transaction
      .update(runtimeNodes)
      .set({ revokedAt: now, revocationReason: reason, pairingState: 'revoked', updatedAt: now })
      .where(eq(runtimeNodes.id, node.id))
    await appendWorkspaceEvent(transaction, {
      eventType: 'runtime_node.revoked',
      payload: { actorUserId: input.actorUserId, reason, runtimeNodeId: node.id },
      workspaceId: input.workspaceId,
    })
    return readRuntimeNode(transaction, input.workspaceId, node.id)
  })
}

/** One node, or a refusal. Revoked nodes are readable but not usable. */
export async function readRuntimeNode(
  database: AgentHqDatabase | AgentHqTransaction,
  workspaceId: string,
  runtimeNodeId: string
): Promise<RuntimeNodeView> {
  const node = await requireNode(database, workspaceId, runtimeNodeId)
  const keys = await database
    .select()
    .from(runtimeNodeKeys)
    .where(eq(runtimeNodeKeys.runtimeNodeId, node.id))
    .orderBy(asc(runtimeNodeKeys.role), desc(runtimeNodeKeys.keyVersion))

  const now = Date.now()
  const lastProof = node.lastProofAt?.getTime() ?? 0
  const health =
    node.pairingState === 'revoked'
      ? 'unknown'
      : lastProof > 0 && now - lastProof <= RUNTIME_NODE_STALE_AFTER_MS
        ? 'healthy'
        : lastProof > 0
          ? 'stale'
          : 'unknown'

  return {
    displayName: node.displayName,
    health,
    id: node.id,
    keys: keys.map((key) => ({
      algorithm: key.algorithm,
      fingerprint: key.fingerprint,
      keyVersion: key.keyVersion,
      publicKey: key.publicKey,
      retiredAt: key.retiredAt?.toISOString() ?? null,
      role: key.role,
      verifiedAt: key.verifiedAt?.toISOString() ?? null,
    })),
    kind: node.kind,
    lastProofAt: node.lastProofAt?.toISOString() ?? null,
    lastSeenAt: node.lastSeenAt?.toISOString() ?? null,
    pairedAt: node.pairedAt.toISOString(),
    pairingState: node.pairingState,
    platform: node.platform,
    revocationReason: node.revocationReason,
    revokedAt: node.revokedAt?.toISOString() ?? null,
    softwareVersion: node.softwareVersion,
    trustMetadata: node.trustMetadata,
  }
}

export async function listRuntimeNodesForUser(
  database: AgentHqDatabase,
  workspaceId: string
): Promise<RuntimeNodeView[]> {
  const rows = await database
    .select({ id: runtimeNodes.id })
    .from(runtimeNodes)
    .where(eq(runtimeNodes.workspaceId, workspaceId))
    .orderBy(asc(runtimeNodes.pairedAt))
  return Promise.all(rows.map((row) => readRuntimeNode(database, workspaceId, row.id)))
}

/**
 * The eligibility gate every remote-command or relay path must pass: the node
 * exists in this workspace, is paired (not revoked), and carries a verified
 * signing key. Returns the signing key fingerprint so callers can audit it.
 */
export async function requireEligibleRuntimeNode(
  database: AgentHqDatabase | AgentHqTransaction,
  workspaceId: string,
  runtimeNodeId: string
): Promise<Readonly<{ id: string; kind: RuntimeNodeKindValue; signingKeyFingerprint: string }>> {
  const node = await requireNode(database, workspaceId, runtimeNodeId)
  if (node.pairingState !== 'paired') {
    throw new RuntimeNodeError('revoked', 'Runtime node is not eligible for commands')
  }
  const [signing] = await database
    .select({ fingerprint: runtimeNodeKeys.fingerprint })
    .from(runtimeNodeKeys)
    .where(
      and(
        eq(runtimeNodeKeys.runtimeNodeId, node.id),
        eq(runtimeNodeKeys.role, 'signing'),
        isNull(runtimeNodeKeys.retiredAt)
      )
    )
    .orderBy(desc(runtimeNodeKeys.keyVersion))
    .limit(1)
  if (!signing)
    throw new RuntimeNodeError('unauthorized', 'Runtime node has no verified signing key')
  return { id: node.id, kind: node.kind, signingKeyFingerprint: signing.fingerprint }
}

/** Issue and store a one-time registration credential for a `remote_host`. */
export async function createRuntimeNodeExchangeCredential(
  database: AgentHqDatabase,
  input: Readonly<{ challengeId: string; digest: string; workspaceId: string }>
): Promise<Readonly<{ expiresAt: Date }>> {
  const expiresAt = new Date(Date.now() + EXCHANGE_CREDENTIAL_LIFETIME_MS)
  await database.insert(runtimeNodeExchangeCredentials).values({
    challengeId: input.challengeId,
    digest: input.digest,
    expiresAt,
    workspaceId: input.workspaceId,
  })
  return { expiresAt }
}

/**
 * Consume a registration credential exactly once. A self-hosted host registers
 * with this plus a proof; it never becomes a user session.
 */
export async function consumeRuntimeNodeExchangeCredential(
  transaction: AgentHqTransaction,
  input: Readonly<{ digest: string; workspaceId: string }>
): Promise<Readonly<{ challengeId: string }>> {
  const [credential] = await transaction
    .select()
    .from(runtimeNodeExchangeCredentials)
    .where(
      and(
        eq(runtimeNodeExchangeCredentials.digest, input.digest),
        eq(runtimeNodeExchangeCredentials.workspaceId, input.workspaceId)
      )
    )
  if (!credential || credential.expiresAt.getTime() <= Date.now()) {
    throw new RuntimeNodeError(
      'exchange_credential_invalid',
      'Runtime node registration credential is invalid or expired'
    )
  }
  // A spent credential is reported as spent rather than unknown: the caller
  // already holds the secret, so the distinction leaks nothing and tells a host
  // that its grant was consumed instead of never existing.
  if (credential.consumedAt) {
    throw new RuntimeNodeError(
      'exchange_credential_invalid',
      'Runtime node registration credential was already used'
    )
  }
  const [consumed] = await transaction
    .update(runtimeNodeExchangeCredentials)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(runtimeNodeExchangeCredentials.id, credential.id),
        isNull(runtimeNodeExchangeCredentials.consumedAt)
      )
    )
    .returning({ challengeId: runtimeNodeExchangeCredentials.challengeId })
  if (!consumed) {
    throw new RuntimeNodeError(
      'exchange_credential_invalid',
      'Runtime node registration credential was already used'
    )
  }
  return consumed
}

/** The challenge a node is answering, with the nonce it must have signed. */
export async function findRuntimeNodeChallenge(
  database: AgentHqDatabase,
  input: Readonly<{ challengeId: string; workspaceId: string }>
): Promise<Readonly<{ id: string; nonce: string }> | null> {
  const [challenge] = await database
    .select({ id: runtimeNodeChallenges.id, nonce: runtimeNodeChallenges.nonce })
    .from(runtimeNodeChallenges)
    .where(
      and(
        eq(runtimeNodeChallenges.id, input.challengeId),
        eq(runtimeNodeChallenges.workspaceId, input.workspaceId)
      )
    )
    .limit(1)
  return challenge ?? null
}

/**
 * The active signing key a node authenticates with. Proof verification reads it
 * so a node cannot present a key it never registered.
 */
export async function activeRuntimeNodeSigningKey(
  database: AgentHqDatabase,
  workspaceId: string,
  runtimeNodeId: string
): Promise<Readonly<{ fingerprint: string; publicKey: string }>> {
  const eligibility = await requireEligibleRuntimeNode(database, workspaceId, runtimeNodeId)
  const [key] = await database
    .select({ publicKey: runtimeNodeKeys.publicKey })
    .from(runtimeNodeKeys)
    .where(
      and(
        eq(runtimeNodeKeys.runtimeNodeId, eligibility.id),
        eq(runtimeNodeKeys.role, 'signing'),
        isNull(runtimeNodeKeys.retiredAt)
      )
    )
    .orderBy(desc(runtimeNodeKeys.keyVersion))
    .limit(1)
  if (!key) throw new RuntimeNodeError('unauthorized', 'Runtime node has no verified signing key')
  return { fingerprint: eligibility.signingKeyFingerprint, publicKey: key.publicKey }
}

/**
 * Complete a registration: a `remote_host` must first spend its one-time
 * exchange credential, so a host cannot register twice with the same grant.
 */
export async function completeRuntimeNodeRegistration(
  database: AgentHqDatabase,
  input: Parameters<typeof registerRuntimeNode>[1] & { exchangeCredential?: string | null }
): Promise<RuntimeNodeView> {
  if (input.kind === 'remote_host') {
    const digest = digestExchangeCredential(input.exchangeCredential ?? '')
    await inTransaction(database, async (transaction) => {
      const credential = await consumeRuntimeNodeExchangeCredential(transaction, {
        digest,
        workspaceId: input.workspaceId,
      })
      if (credential.challengeId !== input.challengeId) {
        throw new RuntimeNodeError(
          'exchange_credential_invalid',
          'Runtime node registration credential does not match this challenge'
        )
      }
    })
  }
  return registerRuntimeNode(database, input)
}

/** Registration credentials are stored as digests, never as usable values. */
export function digestExchangeCredential(credential: string): string {
  return createHash('sha256').update(credential).digest('base64url')
}

/** Retention: drop expired, unconsumed challenges and registration credentials. */
export async function pruneRuntimeNodeCredentials(
  database: AgentHqDatabase,
  limit = 200
): Promise<Readonly<{ challenges: number; exchangeCredentials: number }>> {
  const now = new Date()
  // Credentials first: deleting a challenge cascades to the one referencing it,
  // so a challenge-first pass would remove credentials it never counted.
  const staleCredentials = await database
    .select({ id: runtimeNodeExchangeCredentials.id })
    .from(runtimeNodeExchangeCredentials)
    .where(lt(runtimeNodeExchangeCredentials.expiresAt, now))
    .limit(limit)
  if (staleCredentials.length > 0) {
    await database.delete(runtimeNodeExchangeCredentials).where(
      inArray(
        runtimeNodeExchangeCredentials.id,
        staleCredentials.map((row) => row.id)
      )
    )
  }

  const expiredChallenges = await database
    .select({ id: runtimeNodeChallenges.id })
    .from(runtimeNodeChallenges)
    .where(lt(runtimeNodeChallenges.expiresAt, now))
    .limit(limit)
  if (expiredChallenges.length > 0) {
    await database.delete(runtimeNodeChallenges).where(
      inArray(
        runtimeNodeChallenges.id,
        expiredChallenges.map((row) => row.id)
      )
    )
  }

  return { challenges: expiredChallenges.length, exchangeCredentials: staleCredentials.length }
}
