/**
 * Candidate consumer for the actual locally packed public SDK. This source is
 * copied into a task-owned fixture package; Adea's production dependency pins
 * and routes do not import it. It manages metadata only, never invokes a model,
 * leases a credential, chooses a fallback, or grants execution authority.
 */
import { createHash } from 'node:crypto'
import {
  ControlApiOperations,
  ControlPlaneClient,
  ControlPlaneClientError,
  PublicContractManifest,
  type ModelConnectionCreateRequest,
  type ModelConnectionRevokeRequest,
  type ModelConnectionListRequest,
  type ModelDefaultsSetRequest,
  type ModelSelectionResolveRequest,
  type ModelSelectionFundingRequest,
} from '@adea-ai/sdk'

import { modelReadiness } from '../../apps/web/src/server/model-selection-readiness'

export type CandidateModelConnectionsOptions = Readonly<{
  baseUrl: string
  /** Synthetic fixture service bearer only; never a user's provider credential. */
  serviceToken: string
  workspaceId: string
  servicePrincipalId: string
  requestId: () => string
  traceId: () => string
  commandId: () => string
  now: () => Date
  fetch?: typeof fetch
}>

export class CandidateModelConnectionsError extends Error {
  constructor(readonly reasonCode: string) {
    super('Candidate model metadata operation was not accepted')
    this.name = 'CandidateModelConnectionsError'
  }
}

type Identity = Readonly<{ requestId: string; correlation: Readonly<{ traceId: string }> }>

export function createCandidateModelConnections(options: CandidateModelConnectionsOptions) {
  const url = new URL(options.baseUrl)
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new CandidateModelConnectionsError('READINESS_UNAVAILABLE')
  const client = new ControlPlaneClient({
    baseUrl: url,
    credential: options.serviceToken,
    fetch: options.fetch,
    timeoutMs: 5_000,
  })

  function identity() {
    return {
      caller: { servicePrincipalId: options.servicePrincipalId },
      contractVersion: PublicContractManifest.current,
      correlation: { traceId: options.traceId() },
      requestId: options.requestId(),
      workspaceId: options.workspaceId,
    }
  }

  function read(operation: string, parameters: unknown) {
    return { ...identity(), operation, parameters, requestedAt: options.now().toISOString() }
  }

  function command(operation: string, payload: unknown, idempotencyKey: string) {
    return {
      ...identity(),
      operation,
      payload,
      commandId: options.commandId(),
      idempotencyKey,
      issuedAt: options.now().toISOString(),
      payloadHash: createHash('sha256').update(canonicalJson(payload)).digest('hex'),
    }
  }

  function parse<Output>(parseValue: (value: unknown) => Output, value: unknown): Output {
    try {
      return parseValue(value)
    } catch {
      // Strict schema failures can carry echoed input. Expose a fixed error.
      throw new CandidateModelConnectionsError('READINESS_UNAVAILABLE')
    }
  }

  async function call<Input extends Identity, Output extends Identity>(
    request: Input,
    invoke: (value: Input) => Promise<Output>,
    sameWorkspace: (value: Output) => boolean
  ): Promise<Output> {
    try {
      const response = await invoke(request)
      if (
        response.requestId !== request.requestId ||
        response.correlation.traceId !== request.correlation.traceId ||
        !sameWorkspace(response)
      )
        throw new CandidateModelConnectionsError('READINESS_UNAVAILABLE')
      return response
    } catch (error) {
      // SDK errors may contain raw provider text. Retain only recognized,
      // request-correlated readiness codes, with no error object or cause.
      const reasonCode =
        error instanceof ControlPlaneClientError && error.requestId === request.requestId
          ? modelReadiness({ ready: false, reasonCode: error.code }).reasonCode
          : 'READINESS_UNAVAILABLE'
      throw new CandidateModelConnectionsError(reasonCode)
    }
  }

  return {
    async funding(input: ModelSelectionFundingRequest['parameters']) {
      const operation = ControlApiOperations.getModelSelectionFunding
      const request = parse(
        (value) => operation.requestSchema.parse(value),
        read(operation.operation, input)
      )
      const result = await call(
        request,
        (value) => client.getModelSelectionFunding(value),
        (value) =>
          value.data.funding.workspaceId === options.workspaceId &&
          Object.entries(input).every(
            ([key, expected]) =>
              (value.data.funding as unknown as Record<string, unknown>)[key] === expected
          )
      )
      return result.data.funding
    },
    async create(input: ModelConnectionCreateRequest['payload'], idempotencyKey: string) {
      const operation = ControlApiOperations.createModelConnection
      const request = parse(
        (value) => operation.requestSchema.parse(value),
        command(operation.operation, input, idempotencyKey)
      )
      const result = await call(
        request,
        (value) => client.createModelConnection(value),
        (value) =>
          value.data.connection.workspaceId === options.workspaceId &&
          value.data.connection.credentialRef === input.credentialRef &&
          value.data.connection.credentialRevision === input.credentialRevision
      )
      return result.data.connection
    },
    async revoke(input: ModelConnectionRevokeRequest['payload'], idempotencyKey: string) {
      const operation = ControlApiOperations.revokeModelConnection
      const request = parse(
        (value) => operation.requestSchema.parse(value),
        command(operation.operation, input, idempotencyKey)
      )
      const result = await call(
        request,
        (value) => client.revokeModelConnection(value),
        (value) =>
          value.data.connection.workspaceId === options.workspaceId &&
          value.data.connection.connectionRef === input.connectionRef &&
          value.data.connection.status === 'revoked'
      )
      return result.data.connection
    },
    async list(input: ModelConnectionListRequest['parameters']) {
      const operation = ControlApiOperations.listModelConnections
      const request = parse(
        (value) => operation.requestSchema.parse(value),
        read(operation.operation, input)
      )
      const result = await call(
        request,
        (value) => client.listModelConnections(value),
        (value) =>
          value.data.connections.every(
            (item) => item.connection.workspaceId === options.workspaceId
          )
      )
      return result.data.connections.map((item) => ({
        connection: item.connection,
        models: item.models.map((model) => ({
          providerModel: model.providerModel,
          readiness: modelReadiness(model.readiness),
        })),
      }))
    },
    async getDefaults() {
      const operation = ControlApiOperations.getModelDefaults
      const request = parse(
        (value) => operation.requestSchema.parse(value),
        read(operation.operation, {})
      )
      const result = await call(
        request,
        (value) => client.getModelDefaults(value),
        (value) =>
          value.data.defaults === null || value.data.defaults.workspaceId === options.workspaceId
      )
      return result.data.defaults
    },
    async setDefaults(input: ModelDefaultsSetRequest['payload'], idempotencyKey: string) {
      const operation = ControlApiOperations.setModelDefaults
      const request = parse(
        (value) => operation.requestSchema.parse(value),
        command(operation.operation, input, idempotencyKey)
      )
      const result = await call(
        request,
        (value) => client.setModelDefaults(value),
        (value) =>
          value.data.defaults !== null && value.data.defaults.workspaceId === options.workspaceId
      )
      return result.data.defaults
    },
    async resolve(input: ModelSelectionResolveRequest['parameters']) {
      const operation = ControlApiOperations.resolveModelSelection
      const request = parse(
        (value) => operation.requestSchema.parse(value),
        read(operation.operation, input)
      )
      const result = await call(
        request,
        (value) => client.resolveModelSelection(value),
        (value) => {
          const selection = value.data.selection
          return (
            selection.workspaceId === options.workspaceId &&
            selection.location === input.target.location &&
            selection.harness === input.target.harness &&
            selection.harnessVersion === input.target.harnessVersion &&
            selection.providerBinding === input.target.providerBinding &&
            (!input.override ||
              (selection.connectionRef === input.override.connectionRef &&
                selection.providerModel === input.override.providerModel))
          )
        }
      )
      // Returned immutable metadata remains private admission evidence. The host
      // must pin its reference and revalidate readiness/authority before inference.
      return result.data.selection
    },
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .toSorted()
    .filter((key) => object[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`
}
