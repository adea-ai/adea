/*
 * Files pane (#399): virtualization-friendly lazy tree over `dev.files.list`,
 * client-side filter with quick-open ranking, git modified markers from
 * `dev.git.status`, and create/delete with explicit confirmation. Selecting a
 * file hands a WorkspacePath + identity to the central editor surface.
 */
import type { FileEntry } from '@adea-ai/types/dev-runtime'
import { cn } from '@adea-ai/ui/lib/utils'
import { ChevronDown, ChevronRight, File as FileIcon, Folder, RefreshCw } from 'lucide-solid'
import { For, Show, createResource, createSignal, type JSX } from 'solid-js'

import type { DevRuntimeService } from '../platform'
import {
  filterTree,
  markerBadge,
  markerMap,
  mergeListing,
  rankQuickOpen,
  visibleRows,
  type FileTreeNode,
  type ModificationMarker,
} from './files-model'
import { executeOperation, resolveWorktreeContext, type WorktreeContext } from './worktree-context'
import './files-pane.css'

export type FilesPaneProps = Readonly<{
  runtime: DevRuntimeService
  /** Raised when the user opens a file; the central editor leaf consumes it. */
  onOpenFile?: (file: {
    worktreeId: string
    generation: number
    relativePath: string
    identity: FileEntry['identity']
    rootIdentity: WorktreeContext['rootIdentity']
  }) => void
}>

const LIST_PAGE = 500

export function FilesPane(props: FilesPaneProps): JSX.Element {
  const scope = () => props.runtime.preferenceScope?.()
  const [worktree, setWorktree] = createSignal<WorktreeContext | undefined>()
  const [nodes, setNodes] = createSignal<readonly FileTreeNode[]>([])
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
  const [filter, setFilter] = createSignal('')
  const [markers, setMarkers] = createSignal<ReadonlyMap<string, ModificationMarker>>(new Map())
  const [notice, setNotice] = createSignal<string | undefined>()
  const [confirmDelete, setConfirmDelete] = createSignal<string | undefined>()
  const [creating, setCreating] = createSignal(false)
  const [newName, setNewName] = createSignal('')

  const [contextVersion, setContextVersion] = createSignal(0)

  createResource(contextVersion, async () => {
    const activeScope = scope()
    if (!activeScope || props.runtime.state().status !== 'ready') return
    try {
      const context = await resolveWorktreeContext(props.runtime, activeScope)
      setWorktree(context)
      if (context) await loadDirectory(context, '')
    } catch {
      setWorktree(undefined)
    }
  })

  async function loadDirectory(
    context: WorktreeContext,
    relativePath: string,
    cursor?: string
  ): Promise<void> {
    const activeScope = scope()
    if (!activeScope) return
    const page = await executeOperation<{ items: readonly FileEntry[]; nextCursor?: string }>(
      props.runtime,
      activeScope,
      'dev.files.list',
      {
        worktreeId: context.worktreeId,
        path: {
          worktreeId: context.worktreeId,
          rootIdentity: context.rootIdentity,
          relativePath: relativePath.length === 0 ? '.' : relativePath,
        },
        ...(cursor ? { cursor } : {}),
        limit: LIST_PAGE,
      },
      { kind: 'workspace_root', id: context.worktreeId, generation: context.generation }
    )
    setNodes((current) => mergeListing(current, page.items))
    if (page.nextCursor) await loadDirectory(context, relativePath, page.nextCursor)
  }

  async function refreshMarkers(): Promise<void> {
    const context = worktree()
    const activeScope = scope()
    if (!context || !activeScope) return
    try {
      const status = await executeOperation<{
        entries: readonly {
          path: { relativePath: string }
          staged: string
          unstaged: string
          untracked: boolean
        }[]
      }>(
        props.runtime,
        activeScope,
        'dev.git.status',
        { worktreeId: context.worktreeId, limit: 500 },
        { kind: 'worktree', id: context.worktreeId, generation: context.generation }
      )
      setMarkers(markerMap(status.entries))
    } catch {
      // Read-only pane: markers stay as they were.
    }
  }

  async function toggleDirectory(node: FileTreeNode): Promise<void> {
    const context = worktree()
    if (!context) return
    if (expanded().has(node.relativePath)) {
      const next = new Set(expanded())
      next.delete(node.relativePath)
      setExpanded(next)
      return
    }
    if (node.children.length === 0) {
      try {
        await loadDirectory(context, node.relativePath)
      } catch (reply) {
        setNotice(describeError(reply))
      }
    }
    const next = new Set(expanded())
    next.add(node.relativePath)
    setExpanded(next)
  }

  async function refresh(): Promise<void> {
    setNotice(undefined)
    setNodes([])
    setExpanded(new Set<string>())
    setContextVersion((version) => version + 1)
    await refreshMarkers()
  }

  async function openFile(node: FileTreeNode): Promise<void> {
    const context = worktree()
    if (!context || !node.identity || !props.onOpenFile) return
    props.onOpenFile({
      worktreeId: context.worktreeId,
      generation: context.generation,
      relativePath: node.relativePath,
      identity: node.identity,
      rootIdentity: context.rootIdentity,
    })
  }

  async function createFile(): Promise<void> {
    const context = worktree()
    const activeScope = scope()
    const name = newName().trim()
    if (!context || !activeScope || name.length === 0) return
    if (name.includes('/') || name.includes('\\') || name.startsWith('.')) {
      setNotice('file names must be plain names without separators')
      return
    }
    try {
      await executeOperation(
        props.runtime,
        activeScope,
        'dev.files.create',
        {
          worktreeId: context.worktreeId,
          path: {
            worktreeId: context.worktreeId,
            rootIdentity: context.rootIdentity,
            relativePath: name,
          },
          kind: 'file',
          content: new TextEncoder().encode(''),
          failIfExists: true,
        },
        { kind: 'workspace_root', id: context.worktreeId, generation: context.generation }
      )
      setCreating(false)
      setNewName('')
      await refresh()
    } catch (reply) {
      setNotice(describeError(reply))
    }
  }

  async function deleteFile(node: FileTreeNode): Promise<void> {
    const context = worktree()
    const activeScope = scope()
    if (!context || !activeScope || !node.identity) return
    if (confirmDelete() !== node.relativePath) {
      setConfirmDelete(node.relativePath)
      return
    }
    setConfirmDelete(undefined)
    try {
      await executeOperation(
        props.runtime,
        activeScope,
        'dev.files.delete',
        {
          worktreeId: context.worktreeId,
          path: {
            worktreeId: context.worktreeId,
            rootIdentity: context.rootIdentity,
            relativePath: node.relativePath,
          },
          expectedIdentity: node.identity,
          confirmationId: `files-delete-${node.relativePath}`,
        },
        { kind: 'workspace_root', id: context.worktreeId, generation: context.generation }
      )
      await refresh()
    } catch (reply) {
      setNotice(describeError(reply))
    }
  }

  // Quick-open: flat ranked jump list over the currently loaded paths.
  const loadedPaths = (): readonly string[] => flattenPaths(nodes())
  const quickOpen = () => rankQuickOpen(loadedPaths(), filter())

  const rows = () => {
    const query = filter()
    if (query.length === 0) return visibleRows(nodes(), expanded())
    return visibleRows(filterTree(nodes(), query), new Set(allRelativePaths(nodes())))
  }

  const runtimeReady = () => props.runtime.state().status === 'ready'

  return (
    <section class="dev-files" aria-label="Files">
      <div class="dev-files__toolbar">
        <input
          type="search"
          class="dev-files__filter"
          placeholder="Filter files (quick open)"
          aria-label="Filter files"
          value={filter()}
          onInput={(event) => setFilter(event.currentTarget.value)}
        />
        <button
          type="button"
          class="dev-icon-button"
          aria-label="Refresh files"
          onClick={() => void refresh()}
        >
          <RefreshCw aria-hidden="true" />
        </button>
      </div>
      <Show
        when={runtimeReady()}
        fallback={
          <p class="dev-empty-state">
            File authority is unavailable until the Dev Runtime connects.
          </p>
        }
      >
        <Show
          when={worktree()}
          fallback={
            <p class="dev-empty-state">
              No ready worktree context exists on this runtime node yet.
            </p>
          }
        >
          <div class="dev-files__actions">
            <Show
              when={creating()}
              fallback={
                <button type="button" class="dev-button" onClick={() => setCreating(true)}>
                  New file
                </button>
              }
            >
              <input
                class="dev-files__filter"
                placeholder="new-file-name.txt"
                aria-label="New file name"
                value={newName()}
                onInput={(event) => setNewName(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void createFile()
                  if (event.key === 'Escape') setCreating(false)
                }}
              />
              <button type="button" class="dev-button" onClick={() => void createFile()}>
                Create
              </button>
            </Show>
          </div>
          <Show when={notice()}>
            {(shown) => (
              <p class="dev-terminal-muted" role="alert">
                {shown()}
              </p>
            )}
          </Show>
          <div class="dev-files__tree" role="tree" aria-label="Worktree files">
            <Show
              when={filter().length === 0}
              fallback={
                <For each={quickOpen()}>
                  {(path) => (
                    <button
                      type="button"
                      class="dev-files__row"
                      onClick={() => {
                        const node = findNode(nodes(), path)
                        if (node) void openFile(node)
                      }}
                    >
                      <FileIcon aria-hidden="true" class="dev-files__icon" />
                      <span class="dev-files__name">{path}</span>
                    </button>
                  )}
                </For>
              }
            >
              <For each={rows()}>
                {(row) => (
                  <div
                    class={cn('dev-files__row', { 'dev-files__row--dir': row.hasChildren })}
                    data-depth={Math.min(row.depth, 8)}
                  >
                    <Show
                      when={row.hasChildren}
                      fallback={
                        <>
                          <FileIcon aria-hidden="true" class="dev-files__icon" />
                          <button
                            type="button"
                            class="dev-files__name"
                            onClick={() => void openFile(row.node)}
                          >
                            {row.node.name}
                          </button>
                        </>
                      }
                    >
                      <button
                        type="button"
                        class="dev-files__name"
                        aria-expanded={expanded().has(row.node.relativePath)}
                        onClick={() => void toggleDirectory(row.node)}
                      >
                        <Show
                          when={expanded().has(row.node.relativePath)}
                          fallback={<ChevronRight aria-hidden="true" class="dev-files__icon" />}
                        >
                          <ChevronDown aria-hidden="true" class="dev-files__icon" />
                        </Show>
                        <Folder aria-hidden="true" class="dev-files__icon" />
                        {row.node.name}
                      </button>
                    </Show>
                    <Show when={markerBadge(markers().get(row.node.relativePath))}>
                      {(badge) => <span class="dev-files__badge">{badge()}</span>}
                    </Show>
                    <Show when={!row.hasChildren}>
                      <button
                        type="button"
                        class="dev-files__delete"
                        aria-label={
                          confirmDelete() === row.node.relativePath
                            ? `Confirm delete ${row.node.relativePath}`
                            : `Delete ${row.node.relativePath}`
                        }
                        onClick={() => void deleteFile(row.node)}
                      >
                        {confirmDelete() === row.node.relativePath ? 'Confirm' : 'Delete'}
                      </button>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </Show>
      </Show>
    </section>
  )
}

function flattenPaths(nodes: readonly FileTreeNode[]): readonly string[] {
  const paths: string[] = []
  for (const node of nodes) {
    if (node.kind === 'file') paths.push(node.relativePath)
    paths.push(...flattenPaths(node.children))
  }
  return paths
}

function allRelativePaths(nodes: readonly FileTreeNode[]): readonly string[] {
  const paths: string[] = []
  for (const node of nodes) {
    if (node.kind === 'directory') {
      paths.push(node.relativePath)
      paths.push(...allRelativePaths(node.children))
    }
  }
  return paths
}

function findNode(nodes: readonly FileTreeNode[], relativePath: string): FileTreeNode | undefined {
  for (const node of nodes) {
    if (node.relativePath === relativePath) return node
    const child = findNode(node.children, relativePath)
    if (child) return child
  }
  return undefined
}

function describeError(reply: unknown): string {
  const error = reply as { error?: { code?: string; message?: string } }
  return `${error?.error?.code ?? 'error'}: ${error?.error?.message ?? 'operation failed'}`
}
