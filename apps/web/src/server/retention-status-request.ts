import 'server-only'
import {
  readRetentionStatus,
  RETENTION_CATEGORIES,
  RetentionCleanupError,
  type AgentHqDatabase,
} from '@adea-ai/db'
import type { UserPrincipalRef } from '@adea-ai/types'

import { applicationDatabase } from './database'
import { guardDesktopWorkspaceRequest, withDesktopWorkspaceCors } from './desktop-workspace'
import type { WorkspacePrincipalResolution } from './workspace-principal'
import { workspaceUnavailableResponse } from './workspace-response'

/** Opaque ids here are UUIDs. Local to keep the handler free of the principal import chain. */
function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
}

const OPAQUE_SUBJECT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

export type RetentionStatusDependencies = Readonly<{
  authorize(
    principal: UserPrincipalRef,
    permission: 'runtime.invoke',
    workspaceId: string
  ): Promise<Readonly<{ allowed: boolean }>>
  database?: () => AgentHqDatabase
  resolve(request: Request): Promise<WorkspacePrincipalResolution | null>
}>

/**
 * Read-only retention status for one subject. Owner and admin only, through the
 * existing `runtime.invoke` privilege: no new permission is minted here. The
 * response reports facts (authority, holds, evidence counts, and the period
 * decision). It never dispatches cleanup.
 */
export async function handleRetentionStatus(
  request: Request,
  params: Readonly<{ workspaceId: string }>,
  dependencies: RetentionStatusDependencies
) {
  const respond = (resolution: WorkspacePrincipalResolution, body: unknown, status = 200) =>
    withDesktopWorkspaceCors(
      Response.json(body, { status, headers: { 'cache-control': 'private, no-store' } }),
      request
    )
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) {
    rejected.headers.set('cache-control', 'private, no-store')
    return rejected
  }
  if (!isUuid(params.workspaceId)) return workspaceUnavailableResponse(request)
  const resolution = await dependencies.resolve(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  const authorization = await dependencies.authorize(
    resolution.principal,
    'runtime.invoke',
    params.workspaceId
  )
  if (!authorization.allowed) return workspaceUnavailableResponse(request)

  const url = new URL(request.url)
  const category = url.searchParams.get('category')
  const subjectId = url.searchParams.get('subjectId')
  if (
    !category ||
    !(RETENTION_CATEGORIES as readonly string[]).includes(category) ||
    !subjectId ||
    !OPAQUE_SUBJECT.test(subjectId)
  )
    return respond(resolution, { code: 'invalid_request' }, 400)
  try {
    const status = await readRetentionStatus((dependencies.database ?? applicationDatabase)(), {
      category: category as (typeof RETENTION_CATEGORIES)[number],
      subjectId,
      workspaceId: params.workspaceId,
    })
    return respond(resolution, { status })
  } catch (error) {
    if (error instanceof RetentionCleanupError && error.code === 'invalid_input')
      return respond(resolution, { code: 'invalid_request' }, 400)
    throw error
  }
}
