import '../../src/start/globals.css'
import type {
  CapabilitySnapshot,
  DevCommand,
  DevReply,
  FileEntry,
  FileIdentity,
  Scope,
} from '@adea-ai/types/dev-runtime'
import { render } from 'solid-js/web'

import { FilesPane } from '../../../../packages/dev-view/src/files/files-pane'
import type { DevRuntimeService } from '../../../../packages/dev-view/src/platform'

const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const worktreeId = '00000000-0000-4000-8000-000000000004'
const generation = 7
const rootIdentity = {
  device: 'fixture-device',
  inode: 'fixture-root-inode',
  mtimeNs: '1700000000000000000',
  size: '4096',
}
const observedAt = '2026-01-02T03:04:05.000Z'
const entryCount = 1_200
const pageSize = 500
const entries: readonly FileEntry[] = Array.from({ length: entryCount }, (_, index) => {
  const relativePath = `file-${String(index).padStart(4, '0')}.txt`
  const size = String(100 + index)
  return {
    path: { worktreeId, rootIdentity, relativePath },
    identity: {
      device: 'fixture-device',
      inode: String(index + 1),
      mtimeNs: String(1_700_000_000_000_000 + index),
      size,
      contentSha256: index.toString(16).padStart(64, '0'),
    },
    kind: 'file',
    size,
    observedAt,
  }
})

type ListPageCall = Readonly<{
  cursor?: string
  limit: number
  resource?: Readonly<{ kind: string; id: string; generation: number }>
}>

type OpenedFile = Readonly<{
  worktreeId: string
  generation: number
  relativePath: string
  identity: FileEntry['identity']
  rootIdentity: FileIdentity
}>

const listPageCalls: ListPageCall[] = []
let openedFile: OpenedFile | undefined

function reply(command: DevCommand, value: unknown): DevReply {
  return {
    schemaVersion: 1,
    operation: command.operation,
    requestId: command.requestId,
    ok: true,
    value,
    observedAt,
  } as DevReply
}

const runtime: DevRuntimeService = {
  state: () => ({ status: 'ready' }),
  preferenceScope: () => scope,
  capabilitySnapshot: async (requestedScope): Promise<CapabilitySnapshot> => ({
    scope: requestedScope,
    granted: ['dev.files.read', 'dev.git.read'],
    unavailable: [],
    channelGeneration: generation,
    observedAt,
  }),
  execute: async (command) => {
    switch (command.operation) {
      case 'dev.worktree.list':
        return reply(command, {
          items: [
            {
              id: worktreeId,
              generation,
              lifecycle: 'ready',
              archived: false,
              rootIdentity,
              headRef: 'fixture/main',
            },
          ],
        })
      case 'dev.files.list': {
        const cursor = typeof command.body.cursor === 'string' ? command.body.cursor : undefined
        const start = cursor === undefined ? 0 : Number(cursor)
        const requestedLimit = command.body.limit
        const limit =
          typeof requestedLimit === 'number'
            ? Math.min(pageSize, Math.max(1, Math.trunc(requestedLimit)))
            : pageSize
        listPageCalls.push({
          ...(cursor !== undefined ? { cursor } : {}),
          limit,
          ...(command.resource
            ? {
                resource: {
                  kind: command.resource.kind,
                  id: command.resource.id,
                  generation: command.resource.generation,
                },
              }
            : {}),
        })
        const end = Math.min(entries.length, start + limit)
        return reply(command, {
          items: entries.slice(start, end),
          ...(end < entries.length ? { nextCursor: String(end) } : {}),
        })
      }
      case 'dev.git.status':
        return reply(command, {
          worktreeId,
          headRef: 'fixture/main',
          indexSha: '0'.repeat(40),
          entries: [],
          observedAt,
        })
      default:
        throw new Error(`Unexpected FilesPane operation: ${command.operation}`)
    }
  },
}

const root = document.getElementById('harness-root')
if (!root) throw new Error('Files window harness root is missing')

render(
  () => (
    <FilesPane
      runtime={runtime}
      worktreeId={worktreeId}
      onOpenFile={(file) => {
        openedFile = file
      }}
    />
  ),
  root
)

window.devFilesWindowHarness = {
  report: () => ({
    entryCount,
    listPageCalls: listPageCalls.map((call) => ({ ...call })),
    openedFile,
  }),
}

declare global {
  interface Window {
    devFilesWindowHarness: {
      report(): Readonly<{
        entryCount: number
        listPageCalls: readonly ListPageCall[]
        openedFile?: OpenedFile
      }>
    }
  }
}
