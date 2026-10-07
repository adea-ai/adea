import 'server-only'
import { pullRuntimeNodeCommand, RuntimeNodeDeliveryError } from '@adea-ai/db'

import { applicationDatabase } from './database'
import { guardDesktopWorkspaceRequest, withDesktopWorkspaceCors } from './desktop-workspace'
import { readRuntimeNodePullInput } from './runtime-node-delivery-input'
import { isUuid } from './task-request'

/** Node possession authorizes only this outbound pull. Never resolve or mint a user session. */
export async function handleRuntimeNodePull(
  request: Request,
  params: Readonly<{ workspaceId: string; runtimeNodeId: string }>
) {
  const respond = (body: unknown, status = 200) =>
    withDesktopWorkspaceCors(
      Response.json(body, {
        status,
        headers: {
          'cache-control': 'private, no-store',
          ...(status === 429 ? { 'retry-after': '60' } : {}),
        },
      }),
      request
    )
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) {
    rejected.headers.set('cache-control', 'private, no-store')
    return rejected
  }
  if (!isUuid(params.workspaceId) || !isUuid(params.runtimeNodeId))
    return respond({ code: 'runtime_node_unavailable' }, 404)
  const input = await readRuntimeNodePullInput(request)
  if (!input) return respond({ code: 'invalid_request' }, 400)
  try {
    return respond({ command: await pullRuntimeNodeCommand(applicationDatabase(), params, input) })
  } catch (error) {
    if (!(error instanceof RuntimeNodeDeliveryError))
      return respond({ code: 'runtime_node_unavailable' }, 503)
    return respond(
      { code: `runtime_node_delivery_${error.code}` },
      error.code === 'unavailable' ? 404 : error.code === 'replayed' ? 409 : 429
    )
  }
}
