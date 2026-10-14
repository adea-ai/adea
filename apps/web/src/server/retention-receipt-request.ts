import 'server-only'
import {
  RetentionCleanupError,
  RuntimeNodeDeliveryError,
  recordRuntimeNodeRetentionReceipt,
  type AgentHqDatabase,
} from '@adea-ai/db'

import { applicationDatabase } from './database'
import { guardDesktopWorkspaceRequest, withDesktopWorkspaceCors } from './desktop-workspace'
import { readBoundedJsonBody } from './runtime-node-delivery-input'

/** Opaque ids here are UUIDs. Local to keep the handler free of the principal import chain. */
function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
}

/** A receipt body is a signed envelope plus a few short fields: 4 KiB is generous. */
const RECEIPT_BODY_LIMIT = 4096

type Refusal = Readonly<{ code: string; status: number }>

/**
 * Typed refusals. Unknown, unpaired, revoked, or unsigned nodes all answer as
 * `runtime_node_unavailable`, the same as a pull. Retention refusals keep their
 * code under the `retention_` prefix, so a caller can act on them.
 */
function refusalFor(error: unknown): Refusal {
  if (error instanceof RuntimeNodeDeliveryError) {
    return { code: 'runtime_node_unavailable', status: 404 }
  }
  if (error instanceof RetentionCleanupError) {
    if (error.code === 'invalid_input') return { code: 'invalid_request', status: 400 }
    if (error.code === 'receipt_untrusted') return { code: 'runtime_node_unavailable', status: 404 }
    return { code: `retention_${error.code}`, status: 409 }
  }
  return { code: 'runtime_node_unavailable', status: 503 }
}

/**
 * Node-authenticated trusted cleanup receipt. The caller is the runtime node
 * itself, with no user session. Authority comes only from the node's signed,
 * windowed envelope. Nothing here deletes data: the only effect is an
 * append-only receipt, and only under a live deletion request.
 */
export async function handleRuntimeNodeRetentionReceipt(
  request: Request,
  params: Readonly<{ workspaceId: string; runtimeNodeId: string }>,
  dependencies: Readonly<{ database?: () => AgentHqDatabase }> = {}
) {
  const respond = (body: unknown, status = 200) =>
    withDesktopWorkspaceCors(
      Response.json(body, { status, headers: { 'cache-control': 'private, no-store' } }),
      request
    )
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) {
    rejected.headers.set('cache-control', 'private, no-store')
    return rejected
  }
  if (!isUuid(params.workspaceId) || !isUuid(params.runtimeNodeId))
    return respond({ code: 'runtime_node_unavailable' }, 404)
  const value = await readBoundedJsonBody(request, RECEIPT_BODY_LIMIT)
  if (value === null) return respond({ code: 'invalid_request' }, 400)
  try {
    const database = (dependencies.database ?? applicationDatabase)()
    const result = await recordRuntimeNodeRetentionReceipt(
      database,
      { runtimeNodeId: params.runtimeNodeId, workspaceId: params.workspaceId },
      value
    )
    return respond({ outcome: result.outcome, receiptId: result.receipt.id })
  } catch (error) {
    const refusal = refusalFor(error)
    return respond({ code: refusal.code }, refusal.status)
  }
}
