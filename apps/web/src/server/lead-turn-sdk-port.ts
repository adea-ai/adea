import { ControlApiOperations, ControlPlaneClient } from '@adea-ai/sdk'
import { isRecord, type ControlPlaneHopDependencies } from './control-plane-client'
import type { ControlPlaneCredential } from './control-plane-credential'

export const LEAD_SDK_METHODS = [
  'preparePiDurableLead',
  'lookupPiDurableLead',
  'dispatchPiDurableLead',
  'getPiDurableLeadStatus',
  'getPiDurableLeadProgress',
  'cancelPiDurableLead',
  'getPiDurableLeadPublication',
  'getModelSelectionFunding',
] as const
export type LeadSdkMethod = (typeof LEAD_SDK_METHODS)[number]
export type LeadSdkPort = Readonly<{
  supported: boolean
  preparationSchema: Readonly<{ parse(value: unknown): unknown }> | null
  lookupResponseSchema: Readonly<{ parse(value: unknown): unknown }> | null
  invoke(
    method: LeadSdkMethod,
    credential: ControlPlaneCredential,
    body: Record<string, unknown>,
    dependencies: ControlPlaneHopDependencies
  ): Promise<unknown>
}>
function operation(method: LeadSdkMethod) {
  const value: unknown = Reflect.get(ControlApiOperations, method)
  if (
    !isRecord(value) ||
    typeof value.operation !== 'string' ||
    !isRecord(value.requestSchema) ||
    typeof value.requestSchema.parse !== 'function' ||
    !isRecord(value.responseSchema) ||
    typeof value.responseSchema.parse !== 'function'
  )
    return null
  return value
}
function parser(value: unknown): Readonly<{ parse(value: unknown): unknown }> | null {
  if (!isRecord(value) || typeof value.parse !== 'function') return null
  return {
    parse: (input) => Reflect.apply(value.parse as Function, value, [input]),
  }
}
const preparationResponse = operation('preparePiDurableLead')?.responseSchema
const preparationShape = isRecord(preparationResponse) ? preparationResponse.shape : undefined
/** Activation uses actual exported SDK schemas and methods, never an endpoint fallback. */
export const installedLeadSdkPort: LeadSdkPort = {
  supported: LEAD_SDK_METHODS.every(
    (method) =>
      operation(method) && typeof Reflect.get(ControlPlaneClient.prototype, method) === 'function'
  ),
  preparationSchema: parser(isRecord(preparationShape) ? preparationShape.data : undefined),
  lookupResponseSchema: parser(operation('lookupPiDurableLead')?.responseSchema),
  async invoke(method, credential, body, dependencies) {
    const contract = operation(method)
    const environment = dependencies.environment ?? process.env
    if (
      !contract ||
      body.workspaceId !== credential.workspaceId ||
      body.operation !== contract.operation ||
      !environment.CONTROL_PLANE_ORIGIN
    )
      throw new Error('RUNTIME_UNAVAILABLE')
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
      throw new Error('RUNTIME_UNAVAILABLE')
    const requestSchema = parser(contract.requestSchema)!
    const responseSchema = parser(contract.responseSchema)!
    const client = new ControlPlaneClient({
      baseUrl: url,
      credential: credential.token,
      fetch: dependencies.fetch ?? fetch,
      timeoutMs: 5_000,
    })
    const methodFunction: unknown = Reflect.get(client, method)
    if (typeof methodFunction !== 'function') throw new Error('RUNTIME_UNAVAILABLE')
    const response = responseSchema.parse(
      await Reflect.apply(methodFunction, client, [requestSchema.parse(body)])
    )
    if (
      !isRecord(response) ||
      response.requestId !== body.requestId ||
      !isRecord(response.correlation) ||
      !isRecord(body.correlation) ||
      response.correlation.traceId !== body.correlation.traceId
    )
      throw new Error('RUNTIME_RESPONSE_INVALID')
    return response
  },
}
