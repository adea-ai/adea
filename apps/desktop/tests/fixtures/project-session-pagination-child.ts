import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { registerProjectSessionRuntime } from '../../shell/src/dev-runtime/project-session/register'
import type { DevCommand, DevRuntimePage, RuntimeSession, Scope } from '@adea-ai/types/dev-runtime'

const [mode, dataDir] = process.argv.slice(2)
if ((mode !== 'seed' && mode !== 'continue') || !dataDir) {
  throw new Error('expected seed|continue and an explicitly supplied temporary data directory')
}
const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const projectId = '00000000-0000-4000-8000-000000000020'
const repoId = '00000000-0000-4000-8000-000000000030'
const worktreeId = '00000000-0000-4000-8000-000000000050'
const checkpointPath = join(dataDir, 'pagination-checkpoint.json')
const runtime = registerProjectSessionRuntime({
  authority: { registerCommandProvider() {} },
  dataDir,
  scope,
})
const listProvider = runtime.providers['dev.session.list']
if (!listProvider) throw new Error('missing session list provider')

function sessionId(index: number): string {
  return `00000000-0000-4000-8000-${(index + 256).toString(16).padStart(12, '0')}`
}

function list(body: unknown): DevRuntimePage<RuntimeSession> {
  return listProvider!({
    schemaVersion: 1,
    operation: 'dev.session.list',
    requestId: 'subprocess-pagination',
    nonce: 'subprocess-pagination',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    scope,
    capabilities: ['dev.session.read'],
    body,
  } as DevCommand) as DevRuntimePage<RuntimeSession>
}

if (mode === 'seed') {
  runtime.upsertProject({ id: projectId, scope, repoIds: [repoId], lifecycle: 'ready', version: 1 })
  for (let index = 632; index >= 0; index -= 1) {
    // Seed only synthetic inert records; this never calls create/resume or
    // reaches an actual native session, harness, worktree, or execution process.
    runtime.upsertSession({
      id: sessionId(index),
      scope,
      projectId,
      repoId,
      worktreeId,
      lifecycle: 'completed',
      archived: index >= 620,
      projection: 'structured',
      generation: 1,
      version: 1,
    })
  }
  const first = list({ archived: false, projectId, worktreeId, limit: 500 })
  if (first.items.length !== 500 || first.nextCursor !== sessionId(499)) {
    throw new Error('seed child did not produce the expected bounded first page')
  }
  writeFileSync(
    checkpointPath,
    JSON.stringify({ ids: first.items.map(({ id }) => id), cursor: first.nextCursor }),
    { mode: 0o600 }
  )
  process.stdout.write(JSON.stringify({ mode, pid: process.pid, count: first.items.length }))
} else {
  const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8')) as {
    ids: string[]
    cursor: string
  }
  // This child never seeds. All records must have survived the first process.
  const final = list({
    archived: false,
    projectId,
    worktreeId,
    cursor: checkpoint.cursor,
    limit: 500,
  })
  const archived = list({ archived: true, limit: 500 })
  process.stdout.write(
    JSON.stringify({
      mode,
      pid: process.pid,
      ids: [...checkpoint.ids, ...final.items.map(({ id }) => id)],
      finalCount: final.items.length,
      hasContinuation: final.nextCursor !== undefined,
      archivedIds: archived.items.map(({ id }) => id),
      archivedHasContinuation: archived.nextCursor !== undefined,
    })
  )
}
