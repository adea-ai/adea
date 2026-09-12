// The WorkspaceEvent contract: one registry that names every durable event,
// pins its payload schema version, and refuses payloads that would put private
// content, secrets, or transient presentation data into the durable log.
//
// Every append goes through this registry, so a new event type cannot reach the
// log without a declared version and an aggregate, and a payload cannot carry a
// Message body, a key envelope, or a streaming delta. The log is product state
// for synchronization and replay; it is never the conversation store and never
// a transport transcript.

import type { JsonObject } from './schema'

/** What an event is about, so consumers can route without parsing the payload. */
export type WorkspaceEventAggregateType =
  | 'agent'
  | 'artifact'
  | 'channel'
  | 'content_ref'
  | 'message'
  | 'room'
  | 'task'
  | 'workspace'

export type WorkspaceEventActorKind = 'agent' | 'system' | 'user'

type WorkspaceEventContract = Readonly<{
  /** Payload shape version. Bump it when a payload changes shape. */
  schemaVersion: number
  aggregateType: WorkspaceEventAggregateType
  /**
   * Payload key holding the aggregate's id, when a single aggregate owns the
   * event. Events that describe a collection (`room.reordered`) omit it.
   */
  aggregateIdKey?: string
}>

/**
 * Every durable event type. Transient presentation signals — `message.delta`,
 * typing indicators, cursors, camera and animation frames — are deliberately
 * absent: an unknown type is rejected by `resolveWorkspaceEventContract`.
 */
export const WORKSPACE_EVENT_CONTRACTS = {
  'agent.archived': { schemaVersion: 1, aggregateType: 'agent', aggregateIdKey: 'agentId' },
  'agent.created': { schemaVersion: 1, aggregateType: 'agent', aggregateIdKey: 'agentId' },
  'agent.presentation_updated': {
    schemaVersion: 1,
    aggregateType: 'agent',
    aggregateIdKey: 'agentId',
  },
  'agent.profile_changed': { schemaVersion: 1, aggregateType: 'agent', aggregateIdKey: 'agentId' },
  'agent.room_assigned': { schemaVersion: 1, aggregateType: 'agent', aggregateIdKey: 'agentId' },
  'artifact.availability_changed': {
    schemaVersion: 1,
    aggregateType: 'artifact',
    aggregateIdKey: 'artifactId',
  },
  'artifact.created': { schemaVersion: 1, aggregateType: 'artifact', aggregateIdKey: 'artifactId' },
  'artifact.deleted': { schemaVersion: 1, aggregateType: 'artifact', aggregateIdKey: 'artifactId' },
  'channel.archived': { schemaVersion: 1, aggregateType: 'channel', aggregateIdKey: 'channelId' },
  'channel.created': { schemaVersion: 1, aggregateType: 'channel', aggregateIdKey: 'channelId' },
  'channel.read': { schemaVersion: 1, aggregateType: 'channel', aggregateIdKey: 'channelId' },
  'channel.unread': { schemaVersion: 1, aggregateType: 'channel', aggregateIdKey: 'channelId' },
  'channel.updated': { schemaVersion: 1, aggregateType: 'channel', aggregateIdKey: 'channelId' },
  'content.availability_changed': {
    schemaVersion: 1,
    aggregateType: 'content_ref',
    aggregateIdKey: 'contentRefId',
  },
  'message.created': { schemaVersion: 1, aggregateType: 'message', aggregateIdKey: 'messageId' },
  'message.deleted': { schemaVersion: 1, aggregateType: 'message', aggregateIdKey: 'messageId' },
  'message.updated': { schemaVersion: 1, aggregateType: 'message', aggregateIdKey: 'messageId' },
  'room.archived': { schemaVersion: 1, aggregateType: 'room', aggregateIdKey: 'roomId' },
  'room.created': { schemaVersion: 1, aggregateType: 'room', aggregateIdKey: 'roomId' },
  'room.reordered': { schemaVersion: 1, aggregateType: 'room' },
  'room.updated': { schemaVersion: 1, aggregateType: 'room', aggregateIdKey: 'roomId' },
  'thread.read': { schemaVersion: 1, aggregateType: 'channel', aggregateIdKey: 'channelId' },
  'thread.unread': { schemaVersion: 1, aggregateType: 'channel', aggregateIdKey: 'channelId' },
  'task.archived': { schemaVersion: 1, aggregateType: 'task', aggregateIdKey: 'taskId' },
  'task.artifacts_changed': { schemaVersion: 1, aggregateType: 'task', aggregateIdKey: 'taskId' },
  'task.assigned': { schemaVersion: 1, aggregateType: 'task', aggregateIdKey: 'taskId' },
  'task.cancelled': { schemaVersion: 1, aggregateType: 'task', aggregateIdKey: 'taskId' },
  'task.completed': { schemaVersion: 1, aggregateType: 'task', aggregateIdKey: 'taskId' },
  'task.conversation_changed': {
    schemaVersion: 1,
    aggregateType: 'task',
    aggregateIdKey: 'taskId',
  },
  'task.dependencies_changed': {
    schemaVersion: 1,
    aggregateType: 'task',
    aggregateIdKey: 'taskId',
  },
  'task.in_progress': { schemaVersion: 1, aggregateType: 'task', aggregateIdKey: 'taskId' },
  'task.in_review': { schemaVersion: 1, aggregateType: 'task', aggregateIdKey: 'taskId' },
  'task.queued': { schemaVersion: 1, aggregateType: 'task', aggregateIdKey: 'taskId' },
  'task.room_changed': { schemaVersion: 1, aggregateType: 'task', aggregateIdKey: 'taskId' },
  'task.created': { schemaVersion: 1, aggregateType: 'task', aggregateIdKey: 'taskId' },
  'task.updated': { schemaVersion: 1, aggregateType: 'task', aggregateIdKey: 'taskId' },
  'workspace.archived': { schemaVersion: 1, aggregateType: 'workspace' },
  'workspace.created': { schemaVersion: 1, aggregateType: 'workspace' },
  'workspace.read_all': { schemaVersion: 1, aggregateType: 'workspace' },
  'workspace.reopened': { schemaVersion: 1, aggregateType: 'workspace' },
} as const satisfies Record<string, WorkspaceEventContract>

export type WorkspaceEventType = keyof typeof WORKSPACE_EVENT_CONTRACTS

export const WORKSPACE_EVENT_TYPES = Object.keys(
  WORKSPACE_EVENT_CONTRACTS
) as readonly WorkspaceEventType[]

/**
 * Payload keys that never belong in the durable log, with what they would leak.
 * The check is recursive, so nesting an object does not hide a leak.
 */
export const FORBIDDEN_EVENT_PAYLOAD_KEYS: readonly string[] = [
  // Private body content and provider material.
  'body',
  'bodyText',
  'plaintext',
  'prompt',
  'providerContent',
  // Encryption material: only availability/revision metadata may travel.
  'ciphertext',
  'contentKey',
  'contentKeys',
  'encryptedPayload',
  'keyEnvelope',
  'keyEnvelopes',
  'masterKey',
  'unwrappedKey',
  'wrappedKey',
  // Credentials and signed access to content.
  'accessToken',
  'credential',
  'credentials',
  'localPath',
  'absolutePath',
  'refreshToken',
  'secret',
  'storageUrl',
  'token',
  'url',
  // Transient presentation data: durable history must not depend on it.
  'animation',
  'audio',
  'bytes',
  'camera',
  'delta',
  'deltas',
  'tokens',
  'typing',
]

/** Serialized payload budget for one durable event. */
export const MAX_EVENT_PAYLOAD_BYTES = 8 * 1024

export class WorkspaceEventContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceEventContractError'
  }
}

export function isWorkspaceEventType(value: string): value is WorkspaceEventType {
  return Object.hasOwn(WORKSPACE_EVENT_CONTRACTS, value)
}

/**
 * Resolve the contract for an event type. An unregistered type — including a
 * transient signal such as `message.delta` — is refused rather than logged.
 */
export function resolveWorkspaceEventContract(eventType: string): WorkspaceEventContract {
  if (!isWorkspaceEventType(eventType)) {
    throw new WorkspaceEventContractError(
      `Unknown durable workspace event type: ${eventType}. Register it in WORKSPACE_EVENT_CONTRACTS with a schema version, or keep it out of the durable log.`
    )
  }
  return WORKSPACE_EVENT_CONTRACTS[eventType]
}

function findForbiddenKey(value: unknown, path: readonly string[]): string | undefined {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const found = findForbiddenKey(entry, [...path, String(index)])
      if (found) return found
    }
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_EVENT_PAYLOAD_KEYS.includes(key)) return [...path, key].join('.')
    const found = findForbiddenKey(entry, [...path, key])
    if (found) return found
  }
  return undefined
}

/**
 * Refuse a payload that would leak private content, secrets, or transient
 * presentation data into the durable log, or that exceeds the bounded payload
 * budget. Fails closed: callers cannot opt out.
 */
export function assertCloudSafeEventPayload(eventType: string, payload: JsonObject): void {
  const contract = resolveWorkspaceEventContract(eventType)
  if (contract.aggregateIdKey && typeof payload[contract.aggregateIdKey] !== 'string') {
    throw new WorkspaceEventContractError(
      `${eventType} must carry its aggregate id in "${contract.aggregateIdKey}"`
    )
  }

  const forbidden = findForbiddenKey(payload, [])
  if (forbidden) {
    throw new WorkspaceEventContractError(
      `${eventType} payload carries "${forbidden}", which cannot enter the durable workspace event log`
    )
  }

  const serialized = JSON.stringify(payload)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_EVENT_PAYLOAD_BYTES) {
    throw new WorkspaceEventContractError(
      `${eventType} payload exceeds the ${MAX_EVENT_PAYLOAD_BYTES}-byte durable event budget`
    )
  }
}
