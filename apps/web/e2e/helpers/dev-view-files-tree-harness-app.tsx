import '../../src/start/globals.css'

import { render } from 'solid-js/web'
import {
  createUnavailableDevRuntimeService,
  type DevRuntimeService,
} from '../../../../packages/dev-view/src/platform'
import { FilesPane } from '../../../../packages/dev-view/src/files/files-pane'
import type { DevCommand, DevReply, FileEntry, Scope } from '@adea-ai/types/dev-runtime'

const scope: Scope = {
  accountId: 'files-tree-fixture-account',
  workspaceId: 'files-tree-fixture-workspace',
  runtimeNodeId: 'files-tree-fixture-node',
}
const worktreeId = 'files-tree-fixture-worktree'
const rootIdentity = { device: 'fixture-device', inode: '1', mtimeNs: '1', size: '0' }
const observedAt = '2026-09-30T00:00:00.000Z'
const openedPaths: string[] = []
const operations: string[] = []

function entry(relativePath: string, kind: FileEntry['kind'], serial: number): FileEntry {
  return {
    path: { worktreeId, rootIdentity, relativePath },
    identity: { device: 'fixture-device', inode: String(serial + 1), mtimeNs: '1', size: '0' },
    kind,
    size: '0',
    observedAt,
  }
}

function success(command: DevCommand, value: unknown): DevReply {
  return {
    schemaVersion: 1,
    operation: command.operation,
    requestId: command.requestId,
    ok: true,
    value,
    observedAt,
  } as DevReply
}

function createFilesFixtureRuntime(): DevRuntimeService {
  const unavailable = createUnavailableDevRuntimeService({ now: () => observedAt })
  return {
    ...unavailable,
    state: () => ({ status: 'ready' }),
    preferenceScope: () => scope,
    capabilitySnapshot: async (requestedScope) => ({
      scope: requestedScope,
      granted: [],
      unavailable: [],
      channelGeneration: 1,
      observedAt,
    }),
    execute: async (command) => {
      operations.push(command.operation)
      if (command.operation === 'dev.worktree.list') {
        return success(command, {
          items: [
            {
              id: worktreeId,
              generation: 3,
              lifecycle: 'ready',
              archived: false,
              rootIdentity,
              headRef: 'main',
            },
          ],
        })
      }
      if (command.operation === 'dev.files.list') {
        const body = command.body as { path: { relativePath: string } }
        if (body.path.relativePath === '.') {
          const count = Number(new URLSearchParams(window.location.search).get('rows') ?? 160)
          return success(command, {
            items: [
              entry('src', 'directory', 1),
              ...Array.from({ length: count }, (_, index) =>
                entry(`file-${String(index).padStart(3, '0')}.txt`, 'file', index + 2)
              ),
            ],
          })
        }
        if (body.path.relativePath === 'src') {
          return success(command, {
            items: [entry('src/entry.ts', 'file', 900), entry('src/nested', 'directory', 901)],
          })
        }
        if (body.path.relativePath === 'src/nested') {
          return success(command, { items: [entry('src/nested/leaf.ts', 'file', 902)] })
        }
        return success(command, { items: [] })
      }
      if (command.operation === 'dev.git.status') return success(command, { entries: [] })
      return success(command, {})
    },
  }
}

const runtime = createFilesFixtureRuntime()
const root = document.getElementById('harness-root')
if (!root) throw new Error('Files tree harness root is missing')

render(
  () => <FilesPane runtime={runtime} onOpenFile={(file) => openedPaths.push(file.relativePath)} />,
  root
)

window.devViewFilesTreeHarness = {
  report: () => ({ openedPaths: [...openedPaths], operations: [...operations] }),
}

declare global {
  interface Window {
    devViewFilesTreeHarness: {
      report(): Readonly<{ openedPaths: readonly string[]; operations: readonly string[] }>
    }
  }
}
