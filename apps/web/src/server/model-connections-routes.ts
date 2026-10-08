import type {
  ApiModelConnectionCreateInput,
  ApiModelConnectionRevokeInput,
  ApiModelDefaultsSetInput,
  ApiModelFundingBinding,
  ApiModelFundingView,
  ApiModelSelectionResolveInput,
} from '@adea-ai/api-client/model-connections'
import type { UserPrincipalRef } from '@adea-ai/types'
import type { AdminRouteDependencies } from './control-plane-admin-routes'
import { ControlPlaneProxyError, adminCorrelation, isRecord } from './control-plane-client'
import {
  createWorkspaceModelMetadataAdapter,
  isModelChoice,
  isModelFundingBinding,
  type ModelMetadataDependencies,
} from './model-connections-proxy'

export type ModelMetadataRouteDependencies = Omit<AdminRouteDependencies, 'hop'> &
  Readonly<{
    hop(workspaceId: string): ModelMetadataDependencies
    /** Exact accepted server binding and audience; workspace membership alone is insufficient. */
    authorizeFundingBinding?(
      principal: UserPrincipalRef,
      workspaceId: string,
      binding: ApiModelFundingBinding
    ): Promise<boolean>
  }>

type ParsedRequest =
  | Readonly<{ action: 'connections.create'; input: ApiModelConnectionCreateInput }>
  | Readonly<{ action: 'connections.revoke'; input: ApiModelConnectionRevokeInput }>
  | Readonly<{ action: 'list' | 'defaults.get'; input: Record<string, never> }>
  | Readonly<{ action: 'defaults.set'; input: ApiModelDefaultsSetInput }>
  | Readonly<{ action: 'selection.resolve'; input: ApiModelSelectionResolveInput }>
  | Readonly<{ action: 'funding.get'; input: ApiModelFundingBinding }>

export function parseModelMetadataRequest(value: unknown): ParsedRequest | null {
  if (
    !isRecord(value) ||
    Object.keys(value).toSorted().join(',') !== 'action,input' ||
    !isRecord(value.input)
  )
    return null
  const input = value.input
  const idempotent =
    typeof input.idempotencyKey === 'string' &&
    /^[A-Za-z0-9._:-]{16,128}$/u.test(input.idempotencyKey)
  if (
    value.action === 'connections.create' &&
    Object.keys(input).toSorted().join(',') === 'credentialRef,credentialRevision,idempotencyKey' &&
    typeof input.credentialRef === 'string' &&
    /^crd_[0-9A-HJKMNP-TV-Z]{26}$/u.test(input.credentialRef) &&
    Number.isSafeInteger(input.credentialRevision) &&
    Number(input.credentialRevision) > 0 &&
    idempotent
  ) {
    return {
      action: value.action,
      input: {
        credentialRef: input.credentialRef,
        credentialRevision: Number(input.credentialRevision),
        idempotencyKey: String(input.idempotencyKey),
      },
    }
  }
  if (
    value.action === 'connections.revoke' &&
    Object.keys(input).toSorted().join(',') === 'connectionRef,expectedRevision,idempotencyKey' &&
    typeof input.connectionRef === 'string' &&
    /^mconn_[a-f0-9]{32}$/u.test(input.connectionRef) &&
    Number.isSafeInteger(input.expectedRevision) &&
    Number(input.expectedRevision) > 0 &&
    idempotent
  ) {
    return {
      action: value.action,
      input: {
        connectionRef: input.connectionRef,
        expectedRevision: Number(input.expectedRevision),
        idempotencyKey: String(input.idempotencyKey),
      },
    }
  }
  if (
    (value.action === 'list' || value.action === 'defaults.get') &&
    Object.keys(input).length === 0
  )
    return { action: value.action, input: {} }
  if (value.action === 'funding.get' && isModelFundingBinding(input))
    return { action: value.action, input }
  if (
    value.action === 'selection.resolve' &&
    typeof input.role === 'string' &&
    ['lead', 'child', 'direct'].includes(input.role) &&
    Object.keys(input).every((key) => ['role', 'override'].includes(key)) &&
    (input.override === undefined || isModelChoice(input.override))
  )
    return {
      action: value.action,
      input: {
        role: input.role as ApiModelSelectionResolveInput['role'],
        ...(input.override === undefined ? {} : { override: input.override }),
      },
    }
  if (
    value.action === 'defaults.set' &&
    Object.keys(input).every((key) =>
      ['expectedRevision', 'idempotencyKey', 'lead', 'child', 'direct'].includes(key)
    ) &&
    typeof input.expectedRevision === 'number' &&
    Number.isSafeInteger(input.expectedRevision) &&
    input.expectedRevision >= 0 &&
    typeof input.idempotencyKey === 'string' &&
    /^[A-Za-z0-9._:-]{16,128}$/u.test(input.idempotencyKey) &&
    [input.lead, input.child, input.direct].every(
      (choice) => choice === undefined || isModelChoice(choice)
    )
  )
    return {
      action: value.action,
      input: {
        expectedRevision: input.expectedRevision,
        idempotencyKey: input.idempotencyKey,
        ...(input.lead === undefined
          ? {}
          : { lead: input.lead as ApiModelDefaultsSetInput['lead'] }),
        ...(input.child === undefined
          ? {}
          : { child: input.child as ApiModelDefaultsSetInput['child'] }),
        ...(input.direct === undefined
          ? {}
          : { direct: input.direct as ApiModelDefaultsSetInput['direct'] }),
      },
    }
  return null
}

/** No runtime or model authority is accepted in this workspace metadata route. */
export async function handleModelMetadata(
  request: Request,
  workspaceId: string,
  dependencies: ModelMetadataRouteDependencies
): Promise<Response> {
  const rejected = dependencies.guard(request)
  if (rejected) return rejected
  const resolution = await dependencies.resolvePrincipal(request)
  if (!resolution) return dependencies.unavailable(request, 401)
  if (!(await dependencies.authorize(resolution.principal, 'workspace.read', workspaceId)))
    return dependencies.unavailable(request)
  let parsed: ParsedRequest | null
  try {
    const declared = Number(request.headers.get('content-length') ?? '0')
    if (declared > 16_384) return dependencies.invalid(request)
    const body = await request.text()
    if (new TextEncoder().encode(body).byteLength > 16_384) return dependencies.invalid(request)
    parsed = parseModelMetadataRequest(JSON.parse(body))
  } catch {
    return dependencies.invalid(request)
  }
  if (!parsed) return dependencies.invalid(request)
  const mutation = ['defaults.set', 'connections.create', 'connections.revoke'].includes(
    parsed.action
  )
  if (
    mutation &&
    !(await dependencies.authorize(resolution.principal, 'workspace.update', workspaceId))
  )
    return dependencies.unavailable(request, 403)
  if (
    parsed.action === 'funding.get' &&
    !(await dependencies.authorizeFundingBinding?.(resolution.principal, workspaceId, parsed.input))
  )
    return dependencies.unavailable(request)
  try {
    const canManage = await dependencies.canManage(resolution.principal, workspaceId)
    const hop = dependencies.hop(workspaceId)
    const adapter = createWorkspaceModelMetadataAdapter(
      workspaceId,
      canManage,
      adminCorrelation(request),
      hop
    )
    let payload: unknown
    let fundingView: ApiModelFundingView | undefined
    switch (parsed.action) {
      case 'connections.create':
        payload = await adapter.create(parsed.input)
        break
      case 'connections.revoke':
        payload = await adapter.revoke(parsed.input)
        break
      case 'list':
        payload = await adapter.list()
        break
      case 'defaults.get':
        payload = await adapter.getDefaults()
        break
      case 'defaults.set':
        payload = await adapter.setDefaults(parsed.input)
        break
      case 'selection.resolve':
        payload = { selection: await adapter.resolve(parsed.input) }
        break
      case 'funding.get':
        fundingView = await adapter.funding(parsed.input)
        payload = { funding: fundingView }
        break
    }
    // Recheck publication authorization after the remote hop, including the
    // execution audience for payer disclosure. Revocation never publishes stale data.
    if (
      !(await dependencies.authorize(resolution.principal, 'workspace.read', workspaceId)) ||
      (mutation &&
        !(await dependencies.authorize(resolution.principal, 'workspace.update', workspaceId))) ||
      (parsed.action === 'funding.get' &&
        !(await dependencies.authorizeFundingBinding?.(
          resolution.principal,
          workspaceId,
          parsed.input
        )))
    )
      return dependencies.unavailable(request)
    if (
      fundingView?.state === 'ready' &&
      Date.parse(fundingView.expiresAt) <= (hop.now?.() ?? Date.now())
    ) {
      payload = {
        funding: {
          schemaVersion: fundingView.schemaVersion,
          workspaceId: fundingView.workspaceId,
          executionId: fundingView.executionId,
          attemptId: fundingView.attemptId,
          selectionRef: fundingView.selectionRef,
          selectionRevision: fundingView.selectionRevision,
          state: 'blocked',
          reasonCode: 'READINESS_UNAVAILABLE',
        },
      }
    }
    return dependencies.json(payload, resolution, request, {
      headers: { 'cache-control': 'private, no-store' },
    })
  } catch (error) {
    return dependencies.failure(
      request,
      error instanceof ControlPlaneProxyError ? error.code : 'READINESS_UNAVAILABLE',
      'Model metadata is unavailable',
      error instanceof ControlPlaneProxyError ? error.status : 503
    )
  }
}
