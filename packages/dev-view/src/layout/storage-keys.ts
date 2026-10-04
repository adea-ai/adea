import type { Scope } from '@adea-ai/types/dev-runtime'

/** The V1 storage key remains readable so the client can migrate #447 values. */
export function layoutStorageKey(
  scope: Scope,
  projectId: string,
  runtimeSessionId: string
): string {
  return `adea.dev-layout.v1:${[
    scope.accountId,
    scope.workspaceId,
    scope.runtimeNodeId,
    projectId,
    runtimeSessionId,
  ]
    .map(encodeURIComponent)
    .join(':')}`
}

export function layoutStorageKeyV2(
  scope: Scope,
  projectId: string,
  runtimeSessionId: string
): string {
  return `adea.dev-layout.v2:${[
    scope.accountId,
    scope.workspaceId,
    scope.runtimeNodeId,
    projectId,
    runtimeSessionId,
  ]
    .map(encodeURIComponent)
    .join(':')}`
}

export function pendingLayoutJournalPrefixV2(
  scope: Scope,
  projectId: string,
  runtimeSessionId: string
): string {
  return `${layoutStorageKeyV2(scope, projectId, runtimeSessionId)}:pending-patch.v1:`
}

export function createPendingLayoutJournalKey(
  storage: Pick<Storage, 'getItem' | 'length' | 'key'>,
  scope: Scope,
  projectId: string,
  runtimeSessionId: string
): string {
  const prefix = pendingLayoutJournalPrefixV2(scope, projectId, runtimeSessionId)
  let maximum = -1
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (!key?.startsWith(prefix)) continue
      const suffix = key.slice(prefix.length)
      const sequence = Number(suffix.split('-', 1)[0])
      if (Number.isSafeInteger(sequence)) maximum = Math.max(maximum, sequence)
    }
  } catch {
    // Random suffix and the collision check below still provide a safe key.
  }

  let sequence = maximum + 1
  while (true) {
    const nonce = Math.random().toString(36).slice(2, 10) || '0'
    const key = `${prefix}${String(sequence).padStart(12, '0')}-${Date.now().toString(36)}-${nonce}`
    try {
      if (storage.getItem(key) === null) return key
    } catch {
      return key
    }
    sequence += 1
  }
}
