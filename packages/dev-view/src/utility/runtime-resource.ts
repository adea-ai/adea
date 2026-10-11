import type { Scope } from '@adea-ai/types/dev-runtime'
import { createMemo, createResource, type Accessor } from 'solid-js'

import type { DevRuntimeService } from '../platform'

export type DevUtilityResourceRequest = Readonly<{
  runtime: DevRuntimeService
  scope: Scope | undefined
  runtimeSessionId?: string
  ready: boolean
}>

export type DevUtilityResourceSource = Readonly<{
  runtime: DevRuntimeService
  runtimeSessionId?: string
}>

export type DevUtilityResourceSnapshot<T> = Readonly<{
  request: DevUtilityResourceRequest
  value: T
}>

export type KeyedUtilityResourceSnapshot<Key, Value> = Readonly<{
  request: Key
  value: Value
}>

const sameScope = (left: Scope | undefined, right: Scope | undefined) =>
  left === right ||
  Boolean(
    left &&
    right &&
    left.accountId === right.accountId &&
    left.workspaceId === right.workspaceId &&
    left.runtimeNodeId === right.runtimeNodeId
  )

export const sameDevUtilityRequest = (
  left: DevUtilityResourceRequest | undefined,
  right: DevUtilityResourceRequest | undefined
) =>
  left === right ||
  Boolean(
    left &&
    right &&
    left.runtime === right.runtime &&
    left.runtimeSessionId === right.runtimeSessionId &&
    left.ready === right.ready &&
    sameScope(left.scope, right.scope)
  )

/** Stable identity for runtime-owned reads, including the selected session when requested. */
export function createDevUtilityResourceRequest(
  source: Accessor<DevUtilityResourceSource>,
  sessionScoped = true
): Accessor<DevUtilityResourceRequest | undefined> {
  return createMemo<DevUtilityResourceRequest | undefined>(() => {
    const { runtime, runtimeSessionId } = source()
    const scope = runtime.preferenceScope?.()
    return {
      runtime,
      scope,
      ...(sessionScoped ? { runtimeSessionId } : {}),
      ready: runtime.state().status === 'ready',
    }
  }, undefined, { equals: sameDevUtilityRequest })
}

/** Hide the last value immediately after its runtime, scope, or session changes. */
export function createDevUtilityResource<T>(
  request: Accessor<DevUtilityResourceRequest | undefined>,
  fetcher: (request: DevUtilityResourceRequest) => Promise<T>
) {
  return createKeyedDevUtilityResource(request, sameDevUtilityRequest, fetcher)
}

export function createKeyedDevUtilityResource<Key, Value>(
  request: Accessor<Key | undefined>,
  sameKey: (left: Key | undefined, right: Key | undefined) => boolean,
  fetcher: (request: Key) => Promise<Value>
) {
  const [resource, controls] = createResource(request, async (key) => {
    if (key === undefined) return undefined
    return { request: key, value: await fetcher(key) }
  })
  return [
    () => {
      const currentRequest = request()
      const snapshot = resource()
      return currentRequest !== undefined && sameKey(snapshot?.request, currentRequest)
        ? snapshot
        : undefined
    },
    controls,
    resource,
  ] as const
}
