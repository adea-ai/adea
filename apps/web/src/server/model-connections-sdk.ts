/** Only actual exported public SDK operations may activate this metadata port. */
import { ControlApiOperations, ControlPlaneClient, ControlPlaneClientError } from '@adea-ai/sdk'
import type { ControlPlaneCredential } from './control-plane-credential'
import {
  ControlPlaneProxyError,
  isRecord,
  type ControlPlaneHopDependencies,
} from './control-plane-client'
import { modelReadiness } from './model-selection-readiness'

export const MODEL_METADATA_METHODS = [
  'createModelConnection',
  'revokeModelConnection',
  'listModelConnections',
  'getModelDefaults',
  'setModelDefaults',
  'resolveModelSelection',
  'getModelSelectionFunding',
] as const
export type ModelMetadataMethod = (typeof MODEL_METADATA_METHODS)[number]

export type ModelMetadataPort = Readonly<{
  supported: boolean
  invoke(
    method: ModelMetadataMethod,
    credential: ControlPlaneCredential,
    body: Record<string, unknown>,
    dependencies: ControlPlaneHopDependencies
  ): Promise<unknown>
}>

function operationFor(method: ModelMetadataMethod) {
  const operation: unknown = Reflect.get(ControlApiOperations, method)
  if (
    !isRecord(operation) ||
    typeof operation.path !== 'string' ||
    typeof operation.operation !== 'string' ||
    !isRecord(operation.requestSchema) ||
    !isRecord(operation.responseSchema) ||
    typeof operation.requestSchema.parse !== 'function' ||
    typeof operation.responseSchema.parse !== 'function'
  )
    return null
  return operation
}

/** Older installed releases remain inactive; no fabricated method types or raw HTTP fallback. */
export const installedModelMetadataPort: ModelMetadataPort = {
  supported: MODEL_METADATA_METHODS.every(
    (method) =>
      operationFor(method) &&
      typeof Reflect.get(ControlPlaneClient.prototype, method) === 'function'
  ),
  async invoke(method, credential, body, dependencies) {
    const operation = operationFor(method)
    const environment = dependencies.environment ?? process.env
    try {
      if (
        !operation ||
        body.operation !== operation.operation ||
        body.workspaceId !== credential.workspaceId ||
        !environment.CONTROL_PLANE_ORIGIN
      )
        throw new Error('Unavailable')
      const url = new URL(environment.CONTROL_PLANE_ORIGIN)
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/' ||
        (url.protocol !== 'https:' &&
          (environment.NODE_ENV === 'production' ||
            url.protocol !== 'http:' ||
            !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
      )
        throw new Error('Unavailable')
      const client = new ControlPlaneClient({
        baseUrl: url,
        credential: credential.token,
        fetch: dependencies.fetch ?? fetch,
        timeoutMs: 5_000,
      })
      const requestSchema: unknown = operation.requestSchema
      const responseSchema: unknown = operation.responseSchema
      if (
        !isRecord(requestSchema) ||
        !isRecord(responseSchema) ||
        typeof requestSchema.parse !== 'function' ||
        typeof responseSchema.parse !== 'function'
      )
        throw new Error('Unavailable')
      const request = Reflect.apply(requestSchema.parse, requestSchema, [body])
      const invoke: unknown = Reflect.get(client, method)
      if (typeof invoke !== 'function') throw new Error('Unavailable')
      const response: unknown = await Reflect.apply(invoke, client, [request])
      return Reflect.apply(responseSchema.parse, responseSchema, [response])
    } catch (error) {
      // SDK/validation errors may contain echoed input or provider text.
      const reasonCode =
        error instanceof ControlPlaneClientError && error.requestId === body.requestId
          ? modelReadiness({ ready: false, reasonCode: error.code }).reasonCode
          : 'READINESS_UNAVAILABLE'
      const status =
        error instanceof ControlPlaneClientError &&
        reasonCode !== 'READINESS_UNAVAILABLE' &&
        [400, 403, 404, 409, 422].includes(error.status ?? 0)
          ? error.status!
          : 503
      throw new ControlPlaneProxyError(reasonCode, 'Model metadata is unavailable', status)
    }
  },
}
