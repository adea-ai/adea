import {
  check,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

import { entityId, type JsonObject, timestampColumns } from './conventions'
import { appSchema } from './schema'
import { users } from './identity'
import { workspaces } from './workspaces'

/**
 * Execution hosts owned by Agent HQ.
 *
 * A RuntimeNode is a `local_device` (the paired desktop) or a `remote_host`
 * (a user-controlled server). Agent HQ owns the registration, the stable id, the
 * association, the public keys, the pairing state, rotation, revocation, and the
 * audit trail; the private keys never leave the node, and the *encryption* keys
 * a node uses for remote-command envelopes are a different key class from its
 * signing keys — enforced here, not by convention.
 */

export const runtimeNodeKind = appSchema.enum('runtime_node_kind', ['local_device', 'remote_host'])

export const runtimeNodePairingState = appSchema.enum('runtime_node_pairing_state', [
  'paired',
  'revoked',
])

/** Signing/authentication versus remote-command payload encryption. */
export const runtimeNodeKeyRole = appSchema.enum('runtime_node_key_role', [
  'signing',
  'command_encryption',
])

export const runtimeNodeKeyAlgorithm = appSchema.enum('runtime_node_key_algorithm', [
  'ed25519',
  'x25519',
])

/** What a short-lived challenge is for: pairing, key rotation, or a liveness proof. */
export const runtimeNodeChallengePurpose = appSchema.enum('runtime_node_challenge_purpose', [
  'pair',
  'rotate',
  'proof',
])

export const runtimeNodes = appSchema.table(
  'runtime_nodes',
  {
    id: entityId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    kind: runtimeNodeKind('kind').notNull(),
    displayName: text('display_name').notNull(),
    platform: text('platform').notNull(),
    softwareVersion: text('software_version').notNull(),
    pairingState: runtimeNodePairingState('pairing_state').default('paired').notNull(),
    /** Bounded, product-visible host metadata. Never credentials. */
    trustMetadata: jsonb('trust_metadata').$type<JsonObject>().default({}).notNull(),
    pairedAt: timestamp('paired_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
    /** Last accepted signed proof from the node; health derives from its age. */
    lastProofAt: timestamp('last_proof_at', { mode: 'date', withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { mode: 'date', withTimezone: true }),
    revokedAt: timestamp('revoked_at', { mode: 'date', withTimezone: true }),
    revocationReason: text('revocation_reason'),
    ...timestampColumns(),
  },
  (table) => [
    index('runtime_nodes_workspace_idx').on(table.workspaceId, table.kind),
    index('runtime_nodes_owner_idx').on(table.ownerUserId),
    check(
      'runtime_nodes_revocation_consistent',
      sql`(${table.pairingState} = 'revoked' and ${table.revokedAt} is not null) or (${table.pairingState} = 'paired' and ${table.revokedAt} is null)`
    ),
    check(
      'runtime_nodes_display_name_bounded',
      sql`char_length(${table.displayName}) between 1 and 120`
    ),
  ]
)

export const runtimeNodeKeys = appSchema.table(
  'runtime_node_keys',
  {
    id: entityId(),
    runtimeNodeId: uuid('runtime_node_id')
      .notNull()
      .references(() => runtimeNodes.id, { onDelete: 'cascade' }),
    role: runtimeNodeKeyRole('role').notNull(),
    algorithm: runtimeNodeKeyAlgorithm('algorithm').notNull(),
    /** Raw public key, base64url. The private half never leaves the node. */
    publicKey: text('public_key').notNull(),
    fingerprint: text('fingerprint').notNull(),
    keyVersion: integer('key_version').notNull(),
    /** Set only after the node proved possession of this key version. */
    verifiedAt: timestamp('verified_at', { mode: 'date', withTimezone: true }),
    /** Retired keys stop authenticating but stay recorded for audit. */
    retiredAt: timestamp('retired_at', { mode: 'date', withTimezone: true }),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('runtime_node_keys_version_uidx').on(
      table.runtimeNodeId,
      table.role,
      table.keyVersion
    ),
    uniqueIndex('runtime_node_keys_fingerprint_uidx').on(table.runtimeNodeId, table.fingerprint),
    index('runtime_node_keys_node_idx').on(table.runtimeNodeId, table.role),
    check('runtime_node_keys_key_version_positive', sql`${table.keyVersion} > 0`),
    // A signing key is Ed25519 and a command-encryption key is X25519: the two
    // classes cannot be swapped for one another at the storage layer.
    check(
      'runtime_node_keys_role_algorithm_match',
      sql`(${table.role} = 'signing' and ${table.algorithm} = 'ed25519') or (${table.role} = 'command_encryption' and ${table.algorithm} = 'x25519')`
    ),
  ]
)

/**
 * Short-lived, single-use challenges bound to their recipient. Pairing,
 * rotation, and liveness proofs all consume one, so a captured proof cannot be
 * replayed and cannot be pointed at a different node, workspace, or purpose.
 * The kind *is* the audience: a challenge issued for a `local_device` is only
 * consumable by a `local_device` registration in the same workspace.
 */
export const runtimeNodeChallenges = appSchema.table(
  'runtime_node_challenges',
  {
    id: entityId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    runtimeNodeId: uuid('runtime_node_id').references(() => runtimeNodes.id, {
      onDelete: 'cascade',
    }),
    purpose: runtimeNodeChallengePurpose('purpose').notNull(),
    kind: runtimeNodeKind('kind').notNull(),
    /** Random nonce the node signs; unique so a challenge cannot be duplicated. */
    nonce: text('nonce').notNull(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { mode: 'date', withTimezone: true }),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('runtime_node_challenges_nonce_uidx').on(table.nonce),
    index('runtime_node_challenges_open_idx').on(table.workspaceId, table.purpose, table.expiresAt),
    index('runtime_node_challenges_node_idx').on(table.runtimeNodeId),
  ]
)

/**
 * One-time short-lived registration credentials for a `remote_host` pairing.
 * Only the digest is stored, and consuming it is transactional, so a host
 * cannot register twice with the same exchange credential.
 */
export const runtimeNodeExchangeCredentials = appSchema.table(
  'runtime_node_exchange_credentials',
  {
    id: entityId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    challengeId: uuid('challenge_id')
      .notNull()
      .references(() => runtimeNodeChallenges.id, { onDelete: 'cascade' }),
    digest: text('digest').notNull(),
    expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { mode: 'date', withTimezone: true }),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('runtime_node_exchange_credentials_digest_uidx').on(table.digest),
    index('runtime_node_exchange_credentials_challenge_idx').on(table.challengeId),
  ]
)
