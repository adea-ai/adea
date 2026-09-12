// RuntimeNode registration, pairing, proofs, rotation, and revocation.
//
// Signatures are verified in the route layer; these tests drive the repository
// with synthetic proofs, which is exactly the boundary the repository declares:
// it stores and enforces state, and it never claims to have verified a
// signature itself.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { listWorkspaceEventsAfter } from '../../src/event-log'
import {
  claimTemporaryUserSession,
  createTemporaryUserSession,
  createUserWithAuthIdentity,
  resolveTemporaryUserSession,
} from '../../src/identity'
import {
  activeRuntimeNodeSigningKey,
  completeRuntimeNodeRegistration,
  consumeRuntimeNodeExchangeCredential,
  createRuntimeNodeChallenge,
  createRuntimeNodeExchangeCredential,
  digestExchangeCredential,
  findRuntimeNodeChallenge,
  fingerprintOf,
  listRuntimeNodesForUser,
  PAIRING_CHALLENGE_LIFETIME_MS,
  pruneRuntimeNodeCredentials,
  readRuntimeNode,
  recordRuntimeNodeProof,
  registerRuntimeNode,
  requireEligibleRuntimeNode,
  revokeRuntimeNode,
  rotateRuntimeNodeKeys,
  RuntimeNodeError,
} from '../../src/runtime-nodes'
import {
  runtimeNodeChallenges,
  runtimeNodeExchangeCredentials,
  runtimeNodeKeys,
  temporaryUserSessions,
} from '../../src/schema'
import { inTransaction } from '../../src/transactions'
import { createWorkspaceWithOwner } from '../../src/workspaces'

const connectionUrl = process.env.DATABASE_URL

/** Deterministic pseudo-keys: these tests are about state, not cryptography. */
function fakeKey(seed: string): string {
  return Buffer.from(seed.padEnd(32, '.')).subarray(0, 32).toString('base64url')
}

function keys(signingSeed: string, encryptionSeed: string) {
  return [
    { algorithm: 'ed25519' as const, publicKey: fakeKey(signingSeed), role: 'signing' as const },
    {
      algorithm: 'x25519' as const,
      publicKey: fakeKey(encryptionSeed),
      role: 'command_encryption' as const,
    },
  ]
}

/** `RuntimeNodeError.code` is the stable part of a refusal; the message is not. */
async function refusalCode(action: () => Promise<unknown>): Promise<string> {
  try {
    await action()
  } catch (error) {
    if (error instanceof RuntimeNodeError) return error.code
    throw error
  }
  throw new Error('Expected the action to be refused')
}

describe.skipIf(!connectionUrl)('runtime nodes', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })
  afterAll(async () => connection.close())

  async function fixture(name: string) {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: `${name}-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `${name}-${crypto.randomUUID()}`,
      name,
      owner: owner.principal,
    })
    return { owner, workspace }
  }

  async function challenge(
    workspaceId: string,
    userId: string,
    kind: 'local_device' | 'remote_host',
    purpose: 'pair' | 'rotate' | 'proof' = 'pair',
    runtimeNodeId?: string
  ) {
    return createRuntimeNodeChallenge(connection.db, {
      audience: kind,
      createdByUserId: userId,
      kind,
      nonce: crypto.randomUUID().replaceAll('-', ''),
      purpose,
      runtimeNodeId: runtimeNodeId ?? null,
      workspaceId,
    })
  }

  test('a local device pairs, and re-pairing the same key resumes its identity', async () => {
    const { owner, workspace } = await fixture('runtime-local')
    const pair = await challenge(workspace.id, owner.principal.userId, 'local_device')
    // A pairing challenge is short-lived: it is issued for a human at a browser.
    expect(pair.expiresAt.getTime() - Date.now()).toBeGreaterThan(
      PAIRING_CHALLENGE_LIFETIME_MS - 60_000
    )

    const first = await registerRuntimeNode(connection.db, {
      challengeId: pair.challengeId,
      displayName: 'Owner laptop',
      keys: keys('signing-a', 'encryption-a'),
      kind: 'local_device',
      ownerUserId: owner.principal.userId,
      platform: 'macOS 26.0 arm64',
      softwareVersion: '0.20.0',
      workspaceId: workspace.id,
    })
    expect(first.kind).toBe('local_device')
    expect(first.pairingState).toBe('paired')
    expect(first.keys).toHaveLength(2)
    expect(first.keys.find((key) => key.role === 'signing')?.keyVersion).toBe(1)

    // Restart: same signing key, fresh challenge, same node identity.
    const restarted = await challenge(workspace.id, owner.principal.userId, 'local_device')
    const resumed = await registerRuntimeNode(connection.db, {
      challengeId: restarted.challengeId,
      displayName: 'Owner laptop',
      keys: keys('signing-a', 'encryption-a'),
      kind: 'local_device',
      ownerUserId: owner.principal.userId,
      platform: 'macOS 26.0 arm64',
      softwareVersion: '0.20.1',
      workspaceId: workspace.id,
    })

    expect(resumed.id).toBe(first.id)
    expect(resumed.keys).toHaveLength(2)
    expect(await listRuntimeNodesForUser(connection.db, workspace.id)).toHaveLength(1)
    expect(resumed.lastProofAt).not.toBeNull()
  })

  test('a second device in the same workspace pairs as its own node', async () => {
    const { owner, workspace } = await fixture('runtime-two-devices')
    for (const [name, seed] of [
      ['Laptop', 'signing-laptop'],
      ['Studio', 'signing-studio'],
    ] as const) {
      const pair = await challenge(workspace.id, owner.principal.userId, 'local_device')
      await registerRuntimeNode(connection.db, {
        challengeId: pair.challengeId,
        displayName: name,
        keys: keys(seed, `${seed}-enc`),
        kind: 'local_device',
        ownerUserId: owner.principal.userId,
        platform: 'macOS 26.0 arm64',
        softwareVersion: '0.20.0',
        workspaceId: workspace.id,
      })
    }
    const nodes = await listRuntimeNodesForUser(connection.db, workspace.id)
    expect(nodes.map((node) => node.displayName).toSorted()).toEqual(['Laptop', 'Studio'])
  })

  test('a self-hosted host registers once with its exchange credential', async () => {
    const { owner, workspace } = await fixture('runtime-host')
    const pair = await challenge(workspace.id, owner.principal.userId, 'remote_host')
    const credential = `adea_reg_${crypto.randomUUID().replaceAll('-', '')}`
    await createRuntimeNodeExchangeCredential(connection.db, {
      challengeId: pair.challengeId,
      digest: digestExchangeCredential(credential),
      workspaceId: workspace.id,
    })

    const node = await completeRuntimeNodeRegistration(connection.db, {
      challengeId: pair.challengeId,
      displayName: 'Home server',
      exchangeCredential: credential,
      keys: keys('signing-host', 'encryption-host'),
      kind: 'remote_host',
      ownerUserId: owner.principal.userId,
      platform: 'Ubuntu 26.04',
      softwareVersion: '0.20.0',
      workspaceId: workspace.id,
    })
    expect(node.kind).toBe('remote_host')

    // The credential is spent: a second registration with it is refused, and it
    // never becomes a user session (the node has no session of its own).
    await expect(
      inTransaction(connection.db, (transaction) =>
        consumeRuntimeNodeExchangeCredential(transaction, {
          digest: digestExchangeCredential(credential),
          workspaceId: workspace.id,
        })
      )
    ).rejects.toThrow(/already used/)

    const other = await challenge(workspace.id, owner.principal.userId, 'remote_host')
    await expect(
      completeRuntimeNodeRegistration(connection.db, {
        challengeId: other.challengeId,
        displayName: 'Impostor',
        exchangeCredential: credential,
        keys: keys('signing-impostor', 'encryption-impostor'),
        kind: 'remote_host',
        ownerUserId: owner.principal.userId,
        platform: 'Ubuntu 26.04',
        softwareVersion: '0.20.0',
        workspaceId: workspace.id,
      })
    ).rejects.toThrow(/already used/)

    // A credential is bound to the challenge it was issued for: a fresh
    // credential cannot register against somebody else's challenge.
    const mismatched = `adea_reg_${crypto.randomUUID().replaceAll('-', '')}`
    await createRuntimeNodeExchangeCredential(connection.db, {
      challengeId: other.challengeId,
      digest: digestExchangeCredential(mismatched),
      workspaceId: workspace.id,
    })
    const unrelated = await challenge(workspace.id, owner.principal.userId, 'remote_host')
    await expect(
      completeRuntimeNodeRegistration(connection.db, {
        challengeId: unrelated.challengeId,
        displayName: 'Hijacker',
        exchangeCredential: mismatched,
        keys: keys('signing-hijacker', 'encryption-hijacker'),
        kind: 'remote_host',
        ownerUserId: owner.principal.userId,
        platform: 'Ubuntu 26.04',
        softwareVersion: '0.20.0',
        workspaceId: workspace.id,
      })
    ).rejects.toThrow(/does not match this challenge/)
  })

  test('challenges are single-use, expiring, and bound to their purpose and node', async () => {
    const { owner, workspace } = await fixture('runtime-challenges')
    const pair = await challenge(workspace.id, owner.principal.userId, 'local_device')
    const bound = await registerRuntimeNode(connection.db, {
      challengeId: pair.challengeId,
      displayName: 'Bound device',
      keys: keys('signing-bound', 'encryption-bound'),
      kind: 'local_device',
      ownerUserId: owner.principal.userId,
      platform: 'macOS 26.0 arm64',
      softwareVersion: '0.20.0',
      workspaceId: workspace.id,
    })

    // Replay: the same challenge cannot register twice.
    expect(
      await refusalCode(() =>
        registerRuntimeNode(connection.db, {
          challengeId: pair.challengeId,
          displayName: 'Replay',
          keys: keys('signing-replay', 'encryption-replay'),
          kind: 'local_device',
          ownerUserId: owner.principal.userId,
          platform: 'macOS 26.0 arm64',
          softwareVersion: '0.20.0',
          workspaceId: workspace.id,
        })
      )
    ).toBe('challenge_used')

    // Expiry: a challenge that nobody consumed still refuses after its lifetime.
    const expired = await challenge(workspace.id, owner.principal.userId, 'local_device')
    await connection.db
      .update(runtimeNodeChallenges)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(runtimeNodeChallenges.id, expired.challengeId))
    await expect(
      registerRuntimeNode(connection.db, {
        challengeId: expired.challengeId,
        displayName: 'Too late',
        keys: keys('signing-late', 'encryption-late'),
        kind: 'local_device',
        ownerUserId: owner.principal.userId,
        platform: 'macOS 26.0 arm64',
        softwareVersion: '0.20.0',
        workspaceId: workspace.id,
      })
    ).rejects.toThrow(/expired/)

    // Wrong purpose: a pairing challenge cannot record a liveness proof. The
    // challenge names the same node, so the refusal can only be the purpose.
    const pairingForProof = await challenge(
      workspace.id,
      owner.principal.userId,
      'local_device',
      'pair',
      bound.id
    )
    await expect(
      recordRuntimeNodeProof(connection.db, {
        challengeId: pairingForProof.challengeId,
        runtimeNodeId: bound.id,
        workspaceId: workspace.id,
      })
    ).rejects.toThrow(/does not match this request/)
  })

  test('the two key classes are enforced at the repository and the database', async () => {
    const { owner, workspace } = await fixture('runtime-key-classes')

    // A signing key presented as command-encryption material is refused.
    const pair = await challenge(workspace.id, owner.principal.userId, 'local_device')
    await expect(
      registerRuntimeNode(connection.db, {
        challengeId: pair.challengeId,
        displayName: 'Confused roles',
        keys: [
          { algorithm: 'x25519', publicKey: fakeKey('signing-as-encryption'), role: 'signing' },
          { algorithm: 'x25519', publicKey: fakeKey('encryption-b'), role: 'command_encryption' },
        ],
        kind: 'local_device',
        ownerUserId: owner.principal.userId,
        platform: 'macOS 26.0 arm64',
        softwareVersion: '0.20.0',
        workspaceId: workspace.id,
      })
    ).rejects.toThrow(/must be ed25519/)

    // Reusing one key for both roles is refused.
    const reuse = await challenge(workspace.id, owner.principal.userId, 'local_device')
    await expect(
      registerRuntimeNode(connection.db, {
        challengeId: reuse.challengeId,
        displayName: 'Shared key',
        keys: [
          { algorithm: 'ed25519', publicKey: fakeKey('shared-key'), role: 'signing' },
          { algorithm: 'x25519', publicKey: fakeKey('shared-key'), role: 'command_encryption' },
        ],
        kind: 'local_device',
        ownerUserId: owner.principal.userId,
        platform: 'macOS 26.0 arm64',
        softwareVersion: '0.20.0',
        workspaceId: workspace.id,
      })
    ).rejects.toThrow(/must be distinct/)

    // The database refuses a role/algorithm mismatch even if a caller skips the
    // repository checks.
    const node = await registerRuntimeNode(connection.db, {
      challengeId: (await challenge(workspace.id, owner.principal.userId, 'local_device'))
        .challengeId,
      displayName: 'Honest device',
      keys: keys('signing-honest', 'encryption-honest'),
      kind: 'local_device',
      ownerUserId: owner.principal.userId,
      platform: 'macOS 26.0 arm64',
      softwareVersion: '0.20.0',
      workspaceId: workspace.id,
    })
    // The database refuses the same contradiction even when the repository is
    // bypassed: a raw insert violates the role/algorithm check. Drizzle wraps
    // driver failures, so the constraint is asserted on the wrapped cause.
    const contradiction = await connection.db
      .insert(runtimeNodeKeys)
      .values({
        algorithm: 'ed25519',
        fingerprint: fingerprintOf(fakeKey('wrong-role')),
        keyVersion: 9,
        publicKey: fakeKey('wrong-role'),
        role: 'command_encryption',
        runtimeNodeId: node.id,
      })
      .then(
        () => null,
        (error: unknown) => error as { cause?: { constraint_name?: string } }
      )
    expect(contradiction?.cause?.constraint_name).toBe('runtime_node_keys_role_algorithm_match')
  })

  test('rotation verifies the replacement before retiring the previous key', async () => {
    const { owner, workspace } = await fixture('runtime-rotation')
    const node = await registerRuntimeNode(connection.db, {
      challengeId: (await challenge(workspace.id, owner.principal.userId, 'local_device'))
        .challengeId,
      displayName: 'Rotating device',
      keys: keys('signing-v1', 'encryption-v1'),
      kind: 'local_device',
      ownerUserId: owner.principal.userId,
      platform: 'macOS 26.0 arm64',
      softwareVersion: '0.20.0',
      workspaceId: workspace.id,
    })

    const rotated = await rotateRuntimeNodeKeys(connection.db, {
      challengeId: (
        await challenge(workspace.id, owner.principal.userId, 'local_device', 'rotate', node.id)
      ).challengeId,
      keys: keys('signing-v2', 'encryption-v2'),
      ownerUserId: owner.principal.userId,
      runtimeNodeId: node.id,
      workspaceId: workspace.id,
    })

    const signing = rotated.keys.filter((key) => key.role === 'signing')
    expect(signing).toHaveLength(2)
    expect(signing.find((key) => key.keyVersion === 2)?.retiredAt).toBeNull()
    // The previous key is retired, not deleted: queued envelopes that reference
    // its version stay auditable.
    expect(signing.find((key) => key.keyVersion === 1)?.retiredAt).not.toBeNull()

    const eligibility = await requireEligibleRuntimeNode(connection.db, workspace.id, node.id)
    expect(eligibility.signingKeyFingerprint).toBe(fingerprintOf(fakeKey('signing-v2')))
    expect(await activeRuntimeNodeSigningKey(connection.db, workspace.id, node.id)).toMatchObject({
      publicKey: fakeKey('signing-v2'),
    })
  })

  test('revocation stops eligibility and leaves everything else intact', async () => {
    const { owner, workspace } = await fixture('runtime-revocation')
    const node = await registerRuntimeNode(connection.db, {
      challengeId: (await challenge(workspace.id, owner.principal.userId, 'remote_host'))
        .challengeId,
      displayName: 'Compromised host',
      keys: keys('signing-compromised', 'encryption-compromised'),
      kind: 'remote_host',
      ownerUserId: owner.principal.userId,
      platform: 'Ubuntu 26.04',
      softwareVersion: '0.20.0',
      workspaceId: workspace.id,
    })

    const revoked = await revokeRuntimeNode(connection.db, {
      actorUserId: owner.principal.userId,
      reason: 'device lost',
      runtimeNodeId: node.id,
      workspaceId: workspace.id,
    })
    expect(revoked.pairingState).toBe('revoked')
    expect(revoked.revocationReason).toBe('device lost')
    // Still readable: the record and its audit trail survive revocation.
    expect((await readRuntimeNode(connection.db, workspace.id, node.id)).keys).toHaveLength(2)

    // No new commands, proofs, or rotations are eligible.
    expect(
      await refusalCode(() => requireEligibleRuntimeNode(connection.db, workspace.id, node.id))
    ).toBe('revoked')
    await expect(
      rotateRuntimeNodeKeys(connection.db, {
        challengeId: (
          await challenge(workspace.id, owner.principal.userId, 'remote_host', 'rotate', node.id)
        ).challengeId,
        keys: keys('signing-after-revocation', 'encryption-after-revocation'),
        ownerUserId: owner.principal.userId,
        runtimeNodeId: node.id,
        workspaceId: workspace.id,
      })
    ).rejects.toThrow(/revoked/)
    await expect(
      revokeRuntimeNode(connection.db, {
        actorUserId: owner.principal.userId,
        reason: 'again',
        runtimeNodeId: node.id,
        workspaceId: workspace.id,
      })
    ).rejects.toThrow(/already revoked/)

    // The workspace's own records are untouched: revocation is not data deletion.
    const events = await listWorkspaceEventsAfter(connection.db, workspace.id, 0)
    const revokedEvent = events.find((event) => event.eventType === 'runtime_node.revoked')
    expect(revokedEvent?.payload).toMatchObject({ reason: 'device lost' })
    expect(revokedEvent?.aggregateType).toBe('runtime_node')
    expect(events.some((event) => event.eventType === 'workspace.created')).toBe(true)
  })

  test('a node is invisible from another workspace', async () => {
    const { owner, workspace } = await fixture('runtime-scope-a')
    const other = await fixture('runtime-scope-b')
    const node = await registerRuntimeNode(connection.db, {
      challengeId: (await challenge(workspace.id, owner.principal.userId, 'local_device'))
        .challengeId,
      displayName: 'Scoped device',
      keys: keys('signing-scoped', 'encryption-scoped'),
      kind: 'local_device',
      ownerUserId: owner.principal.userId,
      platform: 'macOS 26.0 arm64',
      softwareVersion: '0.20.0',
      workspaceId: workspace.id,
    })

    await expect(readRuntimeNode(connection.db, other.workspace.id, node.id)).rejects.toThrow(
      /unavailable/
    )
    expect(await listRuntimeNodesForUser(connection.db, other.workspace.id)).toEqual([])
    await expect(
      requireEligibleRuntimeNode(connection.db, other.workspace.id, node.id)
    ).rejects.toThrow(/unavailable/)
    // A proof from the other workspace cannot touch it either.
    const foreign = await challenge(
      other.workspace.id,
      other.owner.principal.userId,
      'local_device'
    )
    await expect(
      recordRuntimeNodeProof(connection.db, {
        challengeId: foreign.challengeId,
        runtimeNodeId: node.id,
        workspaceId: other.workspace.id,
      })
    ).rejects.toThrow(/unavailable/)
  })

  test('the read model carries no private material and reports health from proofs', async () => {
    const { owner, workspace } = await fixture('runtime-read-model')
    const node = await registerRuntimeNode(connection.db, {
      challengeId: (await challenge(workspace.id, owner.principal.userId, 'local_device'))
        .challengeId,
      displayName: 'Healthy device',
      keys: keys('signing-healthy', 'encryption-healthy'),
      kind: 'local_device',
      ownerUserId: owner.principal.userId,
      platform: 'macOS 26.0 arm64',
      softwareVersion: '0.20.0',
      trustMetadata: { hostname: 'studio' },
      workspaceId: workspace.id,
    })

    const serialized = JSON.stringify(node)
    expect(serialized).not.toContain('privateKey')
    expect(serialized).not.toContain('secret')
    for (const key of node.keys) {
      expect(Object.keys(key).toSorted()).toEqual([
        'algorithm',
        'fingerprint',
        'keyVersion',
        'publicKey',
        'retiredAt',
        'role',
        'verifiedAt',
      ])
    }
    expect(node.health).toBe('healthy')
    expect(node.trustMetadata).toEqual({ hostname: 'studio' })

    // A proof refreshes health; a stale proof reads as stale, never as healthy.
    const proof = await recordRuntimeNodeProof(connection.db, {
      challengeId: (
        await challenge(workspace.id, owner.principal.userId, 'local_device', 'proof', node.id)
      ).challengeId,
      runtimeNodeId: node.id,
      workspaceId: workspace.id,
    })
    expect(proof.lastProofAt).not.toBeNull()
  })

  test('pairing, rotation, and revocation are recorded in the durable log', async () => {
    const { owner, workspace } = await fixture('runtime-events')
    const node = await registerRuntimeNode(connection.db, {
      challengeId: (await challenge(workspace.id, owner.principal.userId, 'local_device'))
        .challengeId,
      displayName: 'Audited device',
      keys: keys('signing-audited', 'encryption-audited'),
      kind: 'local_device',
      ownerUserId: owner.principal.userId,
      platform: 'macOS 26.0 arm64',
      softwareVersion: '0.20.0',
      workspaceId: workspace.id,
    })
    await rotateRuntimeNodeKeys(connection.db, {
      challengeId: (
        await challenge(workspace.id, owner.principal.userId, 'local_device', 'rotate', node.id)
      ).challengeId,
      keys: keys('signing-audited-2', 'encryption-audited-2'),
      ownerUserId: owner.principal.userId,
      runtimeNodeId: node.id,
      workspaceId: workspace.id,
    })
    await revokeRuntimeNode(connection.db, {
      actorUserId: owner.principal.userId,
      reason: 'retired',
      runtimeNodeId: node.id,
      workspaceId: workspace.id,
    })

    const events = await listWorkspaceEventsAfter(connection.db, workspace.id, 0)
    const runtimeEvents = events.filter((event) => event.aggregateType === 'runtime_node')
    expect(runtimeEvents.map((event) => event.eventType)).toEqual([
      'runtime_node.paired',
      'runtime_node.key_rotated',
      'runtime_node.revoked',
    ])
    for (const event of runtimeEvents) {
      expect(event.aggregateId).toBe(node.id)
      expect(event.actor).toEqual({ id: owner.principal.userId, kind: 'user' })
    }
    // Pairing records the public identity, never private material.
    expect(JSON.stringify(runtimeEvents)).not.toContain('privateKey')
    expect(runtimeEvents[0]?.payload).toMatchObject({
      signingKeyFingerprint: fingerprintOf(fakeKey('signing-audited')),
    })
  })

  test('credential pruning drops only expired challenges and credentials', async () => {
    const { owner, workspace } = await fixture('runtime-prune')
    const live = await challenge(workspace.id, owner.principal.userId, 'local_device')
    const stale = await challenge(workspace.id, owner.principal.userId, 'remote_host')
    const staleCredential = `adea_reg_${crypto.randomUUID().replaceAll('-', '')}`
    await createRuntimeNodeExchangeCredential(connection.db, {
      challengeId: stale.challengeId,
      digest: digestExchangeCredential(staleCredential),
      workspaceId: workspace.id,
    })

    await connection.db
      .update(runtimeNodeChallenges)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(runtimeNodeChallenges.id, stale.challengeId))
    await connection.db
      .update(runtimeNodeExchangeCredentials)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(runtimeNodeExchangeCredentials.challengeId, stale.challengeId))

    const pruned = await pruneRuntimeNodeCredentials(connection.db)
    expect(pruned.challenges).toBeGreaterThanOrEqual(1)
    expect(pruned.exchangeCredentials).toBeGreaterThanOrEqual(1)

    // The live challenge survives, so an in-flight pairing is never dropped.
    expect(
      await findRuntimeNodeChallenge(connection.db, {
        challengeId: live.challengeId,
        workspaceId: workspace.id,
      })
    ).not.toBeNull()
  })

  test('a signing key from one node cannot authenticate another', async () => {
    const { owner, workspace } = await fixture('runtime-cross-node')
    const first = await registerRuntimeNode(connection.db, {
      challengeId: (await challenge(workspace.id, owner.principal.userId, 'local_device'))
        .challengeId,
      displayName: 'First',
      keys: keys('signing-first', 'encryption-first'),
      kind: 'local_device',
      ownerUserId: owner.principal.userId,
      platform: 'macOS 26.0 arm64',
      softwareVersion: '0.20.0',
      workspaceId: workspace.id,
    })
    const second = await registerRuntimeNode(connection.db, {
      challengeId: (await challenge(workspace.id, owner.principal.userId, 'local_device'))
        .challengeId,
      displayName: 'Second',
      keys: keys('signing-second', 'encryption-second'),
      kind: 'local_device',
      ownerUserId: owner.principal.userId,
      platform: 'macOS 26.0 arm64',
      softwareVersion: '0.20.0',
      workspaceId: workspace.id,
    })

    const firstKey = await activeRuntimeNodeSigningKey(connection.db, workspace.id, first.id)
    const secondKey = await activeRuntimeNodeSigningKey(connection.db, workspace.id, second.id)
    expect(firstKey.publicKey).not.toBe(secondKey.publicKey)
    expect(firstKey.fingerprint).not.toBe(secondKey.fingerprint)

    // Proof challenges are bound to their node: one node's challenge is refused
    // for another node, so a proof cannot be pointed at a different device.
    await expect(
      recordRuntimeNodeProof(connection.db, {
        challengeId: (
          await challenge(workspace.id, owner.principal.userId, 'local_device', 'proof', first.id)
        ).challengeId,
        runtimeNodeId: second.id,
        workspaceId: workspace.id,
      })
    ).rejects.toThrow(/does not match this runtime node/)
  })

  test('a signed-out session does not unpair a node', async () => {
    const credentialDigest = `runtime-signout-${crypto.randomUUID()}`
    const guest = await createTemporaryUserSession(connection.db, {
      credentialDigest,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `runtime-signout-${crypto.randomUUID()}`,
      name: 'Signed out',
      owner: guest.principal,
    })
    const node = await registerRuntimeNode(connection.db, {
      challengeId: (await challenge(workspace.id, guest.principal.userId, 'local_device'))
        .challengeId,
      displayName: 'Owner laptop',
      keys: keys('signing-signout', 'encryption-signout'),
      kind: 'local_device',
      ownerUserId: guest.principal.userId,
      platform: 'macOS 26.0 arm64',
      softwareVersion: '0.20.0',
      workspaceId: workspace.id,
    })

    // Sign-out is the session ending: the node is a durable workspace record and
    // stays paired and eligible, so signing back in finds it where it was.
    await connection.db
      .update(temporaryUserSessions)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(temporaryUserSessions.credentialDigest, credentialDigest))
    expect(await resolveTemporaryUserSession(connection.db, credentialDigest)).toBeNull()

    const afterSignOut = await readRuntimeNode(connection.db, workspace.id, node.id)
    expect(afterSignOut.pairingState).toBe('paired')
    expect(afterSignOut.keys).toHaveLength(2)
    expect((await requireEligibleRuntimeNode(connection.db, workspace.id, node.id)).id).toBe(
      node.id
    )
    const events = await listWorkspaceEventsAfter(connection.db, workspace.id, 0)
    expect(events.filter((event) => event.eventType === 'runtime_node.revoked')).toHaveLength(0)
    expect(events.some((event) => event.eventType === 'runtime_node.paired')).toBe(true)
  })

  test('signing into an account keeps the node identity', async () => {
    const credentialDigest = `runtime-claim-${crypto.randomUUID()}`
    const guest = await createTemporaryUserSession(connection.db, {
      credentialDigest,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `runtime-claim-${crypto.randomUUID()}`,
      name: 'Claimed later',
      owner: guest.principal,
    })
    const node = await registerRuntimeNode(connection.db, {
      challengeId: (await challenge(workspace.id, guest.principal.userId, 'remote_host'))
        .challengeId,
      displayName: 'Home server',
      keys: keys('signing-claim', 'encryption-claim'),
      kind: 'remote_host',
      ownerUserId: guest.principal.userId,
      platform: 'Ubuntu 26.04',
      softwareVersion: '0.20.0',
      workspaceId: workspace.id,
    })

    // Signing into an existing account hands the workspace to that user. The node
    // keeps its id, keys, and eligibility: its scope is the workspace, and the
    // principal that paired it stays on the row as provenance.
    const identity = { provider: 'neon', subject: `runtime-claim-${crypto.randomUUID()}` }
    const registered = await createUserWithAuthIdentity(connection.db, { identity })
    const claimed = await claimTemporaryUserSession(connection.db, { credentialDigest, identity })
    expect(claimed.userId).toBe(registered.userId)
    expect(claimed.userId).not.toBe(guest.principal.userId)

    const listed = await listRuntimeNodesForUser(connection.db, workspace.id)
    expect(listed).toHaveLength(1)
    expect(listed[0]?.id).toBe(node.id)
    expect(listed[0]?.keys.find((key) => key.role === 'signing')?.fingerprint).toBe(
      fingerprintOf(fakeKey('signing-claim'))
    )
    expect((await requireEligibleRuntimeNode(connection.db, workspace.id, node.id)).id).toBe(
      node.id
    )
  })
})
