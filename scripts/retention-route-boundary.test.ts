import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test } from 'bun:test'

// Textual pin: each route file must delegate to the exported handler and carry no
// logic of its own. The handlers are what the boundary tests exercise.

const root = join(import.meta.dir, '..')
const routes = join(root, 'apps/web/src/start/routes/api/v1/workspaces/$workspaceId')
const receiptRoute = readFileSync(
  join(routes, 'runtime-nodes/$runtimeNodeId/retention/cleanup-receipts.ts'),
  'utf8'
)
const statusRoute = readFileSync(join(routes, 'retention/status.ts'), 'utf8')

test('the receipt route delegates to the node-authenticated handler and carries no authority logic', () => {
  expect(receiptRoute).toContain('handleRuntimeNodeRetentionReceipt(request, params)')
  expect(receiptRoute).toContain(
    'OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request)'
  )
  expect(receiptRoute).not.toMatch(
    /resolveWorkspacePrincipal|authorizeWorkspace|recordRuntimeNodeRetentionReceipt|readRetentionStatus/u
  )
})

test('the status route delegates to the owner-gated read-only handler with the real seams', () => {
  expect(statusRoute).toContain('handleRetentionStatus(request, params, {')
  expect(statusRoute).toContain('authorize: authorizeWorkspace')
  expect(statusRoute).toContain('resolve: resolveWorkspacePrincipal')
  expect(statusRoute).not.toMatch(
    /recordRetentionCleanupReceipt|recordRuntimeNodeRetentionReceipt/u
  )
})

test('the generated route tree registers both new routes', () => {
  const tree = readFileSync(join(root, 'apps/web/src/start/routeTree.gen.ts'), 'utf8')
  expect(tree).toContain("'/api/v1/workspaces/$workspaceId/retention/status'")
  expect(tree).toContain(
    "'/api/v1/workspaces/$workspaceId/runtime-nodes/$runtimeNodeId/retention/cleanup-receipts'"
  )
})
