/*
 * Files pane (#399): virtualization-friendly lazy tree over `dev.files.list`,
 * client-side filter with quick-open ranking, git modified markers from
 * `dev.git.status`, create/delete with explicit confirmation, rename with a
 * plan/commit overwrite path, and recursive delete/copy of directories
 * through their dry-run plan summaries (#399 residue). Selecting a file
 * hands a WorkspacePath + identity to the central editor surface.
 */
import type { FileEntry } from '@adea-ai/types/dev-runtime'
import { cn } from '@adea-ai/ui/lib/utils'
import {
  ChevronDown,
  ChevronRight,
  Copy,
  File as FileIcon,
  Folder,
  Pencil,
  RefreshCw,
  Search,
} from 'lucide-solid'
import { For, Show, createResource, createSignal, type JSX } from 'solid-js'

import type { DevRuntimeService } from '../platform'
import {
  filterTree,
  fuzzyQuickOpen,
  markerBadge,
  markerMap,
  mergeListing,
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

type MutationPlanSummary = {
  id: string
  digest: string
  operation: string
  steps: readonly { id: string; kind: string; targetId: string; dependsOn: readonly string[] }[]
}

/** A planned destructive tree mutation awaiting its explicit confirmed
 *  commit: the dry-run summary is shown before the second click. */
type PendingTreePlan = {
  planId: string
  digest: string
  commitOperation: 'dev.files.deleteTreeCommit' | 'dev.files.copyTreeCommit'
  items: number
  summary: string
}

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
  // Rename flow (#399 residue): plain rename first; a named-collision
  // refusal arms the explicit plan/commit overwrite confirm.
  const [renaming, setRenaming] = createSignal<string | undefined>()
  const [renameValue, setRenameValue] = createSignal('')
  const [overwriteTarget, setOverwriteTarget] = createSignal<string | undefined>()
  // A planned tree mutation awaiting its explicit confirmed commit.
  const [pendingTree, setPendingTree] = createSignal<PendingTreePlan | undefined>()

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
        ...(cursor !== undefined ? { cursor } : {}),
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
    if (node.kind === 'directory') {
      await planTreeDelete(node)
      return
    }
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

  // ── Rename (#399 residue) ─────────────────────────────────────────────────

  function beginRename(node: FileTreeNode): void {
    setNotice(undefined)
    setOverwriteTarget(undefined)
    setRenaming(node.relativePath)
    setRenameValue(node.name)
  }

  /** Plain rename first: fail-if-exists, so a collision is refused with the
   *  destination named — that refusal arms the explicit overwrite confirm. */
  async function submitRename(): Promise<void> {
    const context = worktree()
    const activeScope = scope()
    const from = renaming()
    const name = renameValue().trim()
    if (!context || !activeScope || !from || name.length === 0) return
    if (name.includes('/') || name.includes('\\') || name.startsWith('.')) {
      setNotice('names must be plain names without separators')
      return
    }
    const parent = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : ''
    const to = `${parent}${name}`
    try {
      await executeOperation(
        props.runtime,
        activeScope,
        'dev.files.rename',
        {
          worktreeId: context.worktreeId,
          from: {
            worktreeId: context.worktreeId,
            rootIdentity: context.rootIdentity,
            relativePath: from,
          },
          to: {
            worktreeId: context.worktreeId,
            rootIdentity: context.rootIdentity,
            relativePath: to,
          },
          expectedIdentity: findNode(nodes(), from)?.identity,
          failIfExists: true,
        },
        { kind: 'workspace_root', id: context.worktreeId, generation: context.generation }
      )
      setRenaming(undefined)
      setOverwriteTarget(undefined)
      await refresh()
    } catch (reply) {
      const code = (reply as { error?: { code?: string } })?.error?.code
      if (code === 'path_collision') {
        setOverwriteTarget(to)
        setNotice(`${to} already exists — overwrite it? This replaces the destination file.`)
        return
      }
      setNotice(describeError(reply))
    }
  }

  /** The confirmed overwrite: a plan pinning BOTH identities (source and the
   *  collision), committed immediately by this explicit second click. */
  async function commitOverwriteRename(): Promise<void> {
    const context = worktree()
    const activeScope = scope()
    const from = renaming()
    const to = overwriteTarget()
    if (!context || !activeScope || !from || !to) return
    try {
      const liveFrom = await executeOperation<{ identity: FileEntry['identity'] }>(
        props.runtime,
        activeScope,
        'dev.files.stat',
        {
          worktreeId: context.worktreeId,
          path: {
            worktreeId: context.worktreeId,
            rootIdentity: context.rootIdentity,
            relativePath: from,
          },
        },
        { kind: 'workspace_root', id: context.worktreeId, generation: context.generation }
      )
      const liveTo = await executeOperation<{ identity: FileEntry['identity'] }>(
        props.runtime,
        activeScope,
        'dev.files.stat',
        {
          worktreeId: context.worktreeId,
          path: {
            worktreeId: context.worktreeId,
            rootIdentity: context.rootIdentity,
            relativePath: to,
          },
        },
        { kind: 'workspace_root', id: context.worktreeId, generation: context.generation }
      )
      const plan = await executeOperation<MutationPlanSummary>(
        props.runtime,
        activeScope,
        'dev.files.renameOverwritePlan',
        {
          worktreeId: context.worktreeId,
          from: {
            worktreeId: context.worktreeId,
            rootIdentity: context.rootIdentity,
            relativePath: from,
          },
          to: {
            worktreeId: context.worktreeId,
            rootIdentity: context.rootIdentity,
            relativePath: to,
          },
          expectedFromIdentity: liveFrom.identity,
          expectedToIdentity: liveTo.identity,
        },
        { kind: 'workspace_root', id: context.worktreeId, generation: context.generation }
      )
      await executeOperation(
        props.runtime,
        activeScope,
        'dev.files.renameOverwriteCommit',
        { planId: plan.id, planDigest: plan.digest },
        { kind: 'workspace_root', id: context.worktreeId, generation: context.generation }
      )
      setRenaming(undefined)
      setOverwriteTarget(undefined)
      await refresh()
    } catch (reply) {
      setNotice(describeError(reply))
    }
  }

  // ── Recursive delete/copy (#399 residue) ─────────────────────────────────

  /** Dry run: the plan enumerates every item (bounded, symlinks refused);
   *  the pane shows the item count and arms the confirmed commit. */
  async function planTreeDelete(node: FileTreeNode): Promise<void> {
    const context = worktree()
    const activeScope = scope()
    if (!context || !activeScope || !node.identity) return
    if (pendingTree()?.planId !== node.relativePath) {
      try {
        const plan = await executeOperation<MutationPlanSummary>(
          props.runtime,
          activeScope,
          'dev.files.deleteTreePlan',
          {
            worktreeId: context.worktreeId,
            path: {
              worktreeId: context.worktreeId,
              rootIdentity: context.rootIdentity,
              relativePath: node.relativePath,
            },
            expectedIdentity: node.identity,
            confirmationId: `files-delete-tree-${node.relativePath}`,
          },
          { kind: 'workspace_root', id: context.worktreeId, generation: context.generation }
        )
        setPendingTree({
          planId: plan.id,
          digest: plan.digest,
          commitOperation: 'dev.files.deleteTreeCommit',
          items: plan.steps.length,
          summary: node.relativePath,
        })
        setNotice(`Delete ${node.relativePath}: ${plan.steps.length} items. Confirm to delete.`)
      } catch (reply) {
        setNotice(describeError(reply))
      }
      return
    }
    await commitPendingTree()
  }

  /** Copy arm: the first click plans the copy to `<path>-copy` and shows the
   *  dry-run summary; the second click commits it. */
  async function planTreeCopy(node: FileTreeNode): Promise<void> {
    const context = worktree()
    const activeScope = scope()
    if (!context || !activeScope || !node.identity) return
    const destination = `${node.relativePath}-copy`
    if (pendingTree()?.summary !== `${node.relativePath} → ${destination}`) {
      try {
        const plan = await executeOperation<MutationPlanSummary>(
          props.runtime,
          activeScope,
          'dev.files.copyTreePlan',
          {
            worktreeId: context.worktreeId,
            from: {
              worktreeId: context.worktreeId,
              rootIdentity: context.rootIdentity,
              relativePath: node.relativePath,
            },
            to: {
              worktreeId: context.worktreeId,
              rootIdentity: context.rootIdentity,
              relativePath: destination,
            },
            expectedIdentity: node.identity,
            failIfExists: true,
          },
          { kind: 'workspace_root', id: context.worktreeId, generation: context.generation }
        )
        setPendingTree({
          planId: plan.id,
          digest: plan.digest,
          commitOperation: 'dev.files.copyTreeCommit',
          items: plan.steps.length,
          summary: `${node.relativePath} → ${destination}`,
        })
        setNotice(
          `Copy ${node.relativePath} to ${destination}: ${plan.steps.length} items. Confirm to copy.`
        )
      } catch (reply) {
        setNotice(describeError(reply))
      }
      return
    }
    await commitPendingTree()
  }

  async function commitPendingTree(): Promise<void> {
    const context = worktree()
    const activeScope = scope()
    const pending = pendingTree()
    if (!context || !activeScope || !pending) return
    setPendingTree(undefined)
    try {
      await executeOperation(
        props.runtime,
        activeScope,
        pending.commitOperation,
        { planId: pending.planId, planDigest: pending.digest },
        { kind: 'workspace_root', id: context.worktreeId, generation: context.generation }
      )
      setNotice(undefined)
      await refresh()
    } catch (reply) {
      setNotice(describeError(reply))
    }
  }

  // Quick-open (#399 residue): a keyboard-first file picker (Ctrl/Cmd+P) over
  // the currently loaded paths, ranked fuzzily, opening through the same
  // onOpenFile path as tree selection. Bounded to 20 results.
  const [quickOpenOpen, setQuickOpenOpen] = createSignal(false)
  const [quickOpenQuery, setQuickOpenQuery] = createSignal('')
  const [quickOpenIndex, setQuickOpenIndex] = createSignal(0)
  let quickOpenInput: HTMLInputElement | undefined
  const loadedPaths = (): readonly string[] => flattenPaths(nodes())
  const quickOpenResults = (): readonly string[] => fuzzyQuickOpen(loadedPaths(), quickOpenQuery())

  function openQuickOpen(): void {
    setNotice(undefined)
    setQuickOpenQuery('')
    setQuickOpenIndex(0)
    setQuickOpenOpen(true)
    queueMicrotask(() => quickOpenInput?.focus())
  }

  function closeQuickOpen(): void {
    setQuickOpenOpen(false)
    setQuickOpenQuery('')
    setQuickOpenIndex(0)
  }

  function openQuickOpenResult(relativePath: string): void {
    closeQuickOpen()
    const node = findNode(nodes(), relativePath)
    if (node) void openFile(node)
  }

  function moveQuickOpenIndex(step: 1 | -1): void {
    const count = quickOpenResults().length
    if (count === 0) return
    setQuickOpenIndex((current) => (current + step + count) % count)
  }

  const rows = () => {
    const query = filter()
    if (query.length === 0) return visibleRows(nodes(), expanded())
    return visibleRows(filterTree(nodes(), query), new Set(allRelativePaths(nodes())))
  }

  const runtimeReady = () => props.runtime.state().status === 'ready'

  return (
    <section
      class="dev-files"
      aria-label="Files"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
          if (event.key.toLowerCase() === 'p') {
            event.preventDefault()
            if (quickOpenOpen()) closeQuickOpen()
            else openQuickOpen()
          }
          return
        }
        if (event.key === 'Escape' && quickOpenOpen()) closeQuickOpen()
      }}
    >
      <div class="dev-files__toolbar">
        <input
          type="search"
          class="dev-files__filter"
          placeholder="Filter files"
          aria-label="Filter files"
          value={filter()}
          onInput={(event) => setFilter(event.currentTarget.value)}
        />
        <button
          type="button"
          class="dev-icon-button"
          aria-label="Quick open files"
          title="Quick open (Ctrl+P)"
          onClick={() => openQuickOpen()}
        >
          <Search aria-hidden="true" />
        </button>
        <button
          type="button"
          class="dev-icon-button"
          aria-label="Refresh files"
          onClick={() => void refresh()}
        >
          <RefreshCw aria-hidden="true" />
        </button>
      </div>
      <Show when={quickOpenOpen()}>
        <div class="dev-files__quickopen" role="dialog" aria-label="Quick open">
          <input
            type="search"
            class="dev-files__filter"
            placeholder="Jump to a file…"
            aria-label="Quick open file"
            value={quickOpenQuery()}
            ref={(element) => {
              quickOpenInput = element
            }}
            onInput={(event) => {
              setQuickOpenQuery(event.currentTarget.value)
              setQuickOpenIndex(0)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                moveQuickOpenIndex(1)
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                moveQuickOpenIndex(-1)
              } else if (event.key === 'Enter') {
                event.preventDefault()
                const selected = quickOpenResults()[quickOpenIndex()]
                if (selected !== undefined) openQuickOpenResult(selected)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                closeQuickOpen()
              }
            }}
          />
          <div class="dev-files__quickopen-list" role="listbox" aria-label="Matching files">
            <Show
              when={quickOpenResults().length > 0}
              fallback={
                <p class="dev-terminal-muted dev-files__quickopen-empty">
                  No loaded file matches. Expand more of the tree, then search again.
                </p>
              }
            >
              <For each={quickOpenResults()}>
                {(path, index) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={index() === quickOpenIndex()}
                    class={cn('dev-files__row', {
                      'dev-files__quickopen-row--active': index() === quickOpenIndex(),
                    })}
                    onMouseDown={(event) => {
                      // Select on press so a click cannot land on stale focus.
                      event.preventDefault()
                      openQuickOpenResult(path)
                    }}
                  >
                    <FileIcon aria-hidden="true" class="dev-files__icon" />
                    <span class="dev-files__name">{path}</span>
                  </button>
                )}
              </For>
            </Show>
          </div>
        </div>
      </Show>
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
                <For each={fuzzyQuickOpen(loadedPaths(), filter())}>
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
                    <Show when={renaming() === row.node.relativePath}>
                      <input
                        class="dev-files__filter"
                        aria-label={`Rename ${row.node.relativePath}`}
                        value={renameValue()}
                        onInput={(event) => setRenameValue(event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            if (overwriteTarget()) void commitOverwriteRename()
                            else void submitRename()
                          }
                          if (event.key === 'Escape') {
                            setRenaming(undefined)
                            setOverwriteTarget(undefined)
                          }
                        }}
                      />
                    </Show>
                    <Show when={renaming() !== row.node.relativePath}>
                      <button
                        type="button"
                        class="dev-files__delete"
                        aria-label={`Rename ${row.node.relativePath}`}
                        onClick={() => beginRename(row.node)}
                      >
                        <Pencil aria-hidden="true" />
                      </button>
                    </Show>
                    <Show when={row.hasChildren && renaming() !== row.node.relativePath}>
                      <button
                        type="button"
                        class="dev-files__delete"
                        aria-label={
                          pendingTree()?.commitOperation === 'dev.files.copyTreeCommit' &&
                          pendingTree()?.summary ===
                            `${row.node.relativePath} → ${row.node.relativePath}-copy`
                            ? `Confirm copy ${row.node.relativePath}`
                            : `Copy ${row.node.relativePath}`
                        }
                        onClick={() => void planTreeCopy(row.node)}
                      >
                        <Copy aria-hidden="true" />
                      </button>
                    </Show>
                    <Show
                      when={renaming() === row.node.relativePath && overwriteTarget() !== undefined}
                      fallback={
                        <Show when={renaming() !== row.node.relativePath}>
                          <button
                            type="button"
                            class="dev-files__delete"
                            aria-label={
                              confirmDelete() === row.node.relativePath ||
                              pendingTree()?.summary === row.node.relativePath
                                ? `Confirm delete ${row.node.relativePath}`
                                : `Delete ${row.node.relativePath}`
                            }
                            onClick={() => void deleteFile(row.node)}
                          >
                            {row.hasChildren
                              ? pendingTree()?.summary === row.node.relativePath
                                ? 'Confirm'
                                : 'Delete'
                              : confirmDelete() === row.node.relativePath
                                ? 'Confirm'
                                : 'Delete'}
                          </button>
                        </Show>
                      }
                    >
                      <button
                        type="button"
                        class="dev-files__delete"
                        aria-label={`Confirm overwrite ${overwriteTarget()}`}
                        onClick={() => void commitOverwriteRename()}
                      >
                        Overwrite
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
