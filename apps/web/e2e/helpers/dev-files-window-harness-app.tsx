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
import { createSignal } from 'solid-js'

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
function entry(relativePath: string, serial: number, kind: FileEntry['kind'] = 'file'): FileEntry {
  const size = String(100 + serial)
  return {
    path: { worktreeId, rootIdentity, relativePath },
    identity: {
      device: 'fixture-device',
      inode: String(serial + 1),
      mtimeNs: String(1_700_000_000_000_000 + serial),
      size,
      contentSha256: serial.toString(16).padStart(64, '0'),
    },
    kind,
    size,
    observedAt,
  }
}

const entries: readonly FileEntry[] = Array.from({ length: entryCount }, (_, index) =>
  entry(`file-${String(index).padStart(4, '0')}.txt`, index)
)

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
// The open file's path mirrors the workspace entry's activeEditorFile so the
// tree's selected-row affordance can be exercised deterministically.
const [openPath, setOpenPath] = createSignal<string | undefined>(undefined)

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
        const requestedPath = (command.body.path as { relativePath?: unknown }).relativePath
        const treeFixture = new URLSearchParams(window.location.search).get('shape') === 'tree'
        if (treeFixture && requestedPath === 'src') {
          return reply(command, { items: [entry('src/entry.ts', entryCount + 1)] })
        }
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
        const requestedRows = Number(new URLSearchParams(window.location.search).get('rows'))
        const rowCount =
          treeFixture && Number.isInteger(requestedRows) && requestedRows > 0
            ? Math.min(requestedRows, entries.length)
            : entries.length
        const listing: readonly FileEntry[] = treeFixture
          ? [entry('src', entryCount + 2, 'directory'), ...entries.slice(0, rowCount)]
          : entries
        const end = Math.min(listing.length, start + limit)
        return reply(command, {
          items: listing.slice(start, end),
          ...(end < listing.length ? { nextCursor: String(end) } : {}),
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
      openPath={openPath()}
      onOpenFile={(file) => {
        openedFile = file
        setOpenPath(file.relativePath)
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
