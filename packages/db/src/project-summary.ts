// Canonical ProjectSummary projection (M14.03.2, adea#1218).
//
// One mapper for every project read: `projects.ts`, `project-sharing.ts` and
// `project-state-policy.ts` all return this shape, so revision and dimension
// fields cannot drift between paths. `version` is the monotonic optimistic
// revision (every row UPDATE increments it); timestamps remain display-only.
import type { ProjectSummary } from '@adea-ai/types'

import { projects } from './schema'

export function projectSummary(row: typeof projects.$inferSelect): ProjectSummary {
  return Object.freeze({
    createdAt: row.createdAt.toISOString(),
    iconKey: row.iconKey,
    id: row.id,
    lifecycleState: row.lifecycleState,
    name: row.name,
    sortOrder: row.sortOrder,
    sourceKind: row.sourceKind,
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
    visibility: row.visibility,
    workspaceId: row.workspaceId,
  })
}
