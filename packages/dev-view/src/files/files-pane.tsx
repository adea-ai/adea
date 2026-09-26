/*
 * Files pane (#399): virtualization-friendly lazy tree over `dev.files.list`,
 * client-side filter with quick-open ranking, git modified markers from
 * `dev.git.status`, create/delete with explicit confirmation, rename with a
 * plan/commit overwrite path, and recursive delete/copy of directories
 * through their dry-run plan summaries (#399 residue). Selecting a file
 * hands a WorkspacePath + identity to the central editor surface.
 */
import type { FileEntry, Scope } from '@adea-ai/types/dev-runtime'
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
import { For, Show, createMemo, createResource, createSignal, onCleanup, type JSX } from 'solid-js'

import type { DevRuntimeService } from '../platform'
import {
  fuzzyQuickOpen,
  markerBadge,
  markerMap,
  mergeListing,
  visibleRows,
  type FileTreeNode,
  type ModificationMarker,
} from './files-model'
import { FILES_ROW_HEIGHT_PX, rowWindow } from './row-window'
import {
  CONTENT_SEARCH_LIMIT,
  contentSearchBody,
  contentSearchRows,
  matchLabel,
  matchSummary,
  previewSegments,
  searchQuery,
  type ContentSearchRow,
} from './search-model'
import {
  cacheStatus,
  emptyStatusCache,
  invalidateStatus,
  pushInvalidationDecision,
  refenceStatusCache,
  type StatusCacheSnapshot,
} from './status-cache'
import { executeOperation, resolveWorktreeContext, type WorktreeContext } from './worktree-context'
import './files-pane.css'

export type FilesPaneProps = Readonly<{
  runtime: DevRuntimeService
  /**
   * The selected session's worktree. Resolved in preference to "the first
   * ready worktree on the node", which showed and acted on the wrong worktree
   * whenever a node had more than one.
   */
  worktreeId?: string
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
  summary: string
}

export function FilesPane(props: FilesPaneProps): JSX.Element {
  const scope = () => props.runtime.preferenceScope?.()
  const [worktree, setWorktree] = createSignal<WorktreeContext | undefined>()
  const [nodes, setNodes] = createSignal<readonly FileTreeNode[]>([])
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
  const [filter, setFilter] = createSignal('')
  // Content search is a separate result set from the listing filter: the
  // filter narrows what is already loaded, this asks the host's ripgrep.
  const [contentRows, setContentRows] = createSignal<readonly ContentSearchRow[]>([])
  const [contentTruncated, setContentTruncated] = createSignal(false)
  const [contentFailed, setContentFailed] = createSignal<string | undefined>(undefined)
  const [contentQuery, setContentQuery] = createSignal('')
  // Windowed rendering (#677): the tree renders a slice of its flattened rows,
  // so what is on screen decides what exists in the DOM.
  const [scrollTop, setScrollTop] = createSignal(0)
  const [viewportHeight, setViewportHeight] = createSignal(0)
  const [focusedRow, setFocusedRow] = createSignal<number | undefined>(undefined)
  let treeElement: HTMLDivElement | undefined
  // Marker cache: the files pane follows the same watcher-lane honesty
  // contract as the source-control pane (#399 residue) — invalidation and
  // failed refreshes clear the markers (undefined is the honest state, never
  // stale badges labeled fresh), and only a successful `dev.git.status`
  // dispatch through the capability-checked gate repopulates them.
  const [markerCache, setMarkerCache] = createSignal<
    StatusCacheSnapshot<ReadonlyMap<string, ModificationMarker>>
  >(emptyStatusCache(0))
  const markers = (): ReadonlyMap<string, ModificationMarker> => markerCache().value ?? new Map()
  const [notice, setNotice] = createSignal<string | undefined>()
  const [statusTruncated, setStatusTruncated] = createSignal(false)
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

  // ── Push invalidation (M12) ─────────────────────────────────────────────────
  //
  // The marker cache consumes the shell watcher lane's pushes through the
  // shared decision (status-cache.pushInvalidationDecision): a same-generation
  // tree change kills the markers and repopulates through the
  // capability-checked pull, a moved generation re-resolves the context
  // (re-fence), and the watcher's own refreshed/stopped bookkeeping is
  // ignored. Push never carries marker bytes; with no event surface (web
  // non-desktop runtime) the pane keeps generation-fenced pull.
  let disposePush: (() => void) | undefined
  let pushWired = false
  function wirePushInvalidation(activeScope: Scope): void {
    if (pushWired) return
    pushWired = true
    const events = props.runtime.events?.()
    if (!events) return
    disposePush = events.on('git.statusInvalidated', activeScope, (event) => {
      const context = worktree()
      if (!context) return
      const decision = pushInvalidationDecision(context, event)
      if (decision === 'invalidate') void refreshMarkers()
      else if (decision === 'refence') void refresh()
    })
  }
  onCleanup(() => disposePush?.())

  createResource(contextVersion, async () => {
    const activeScope = scope()
    if (!activeScope || props.runtime.state().status !== 'ready') return
    wirePushInvalidation(activeScope)
    try {
      const context = await resolveWorktreeContext(props.runtime, activeScope, props.worktreeId)
      setWorktree(context)
      if (context) {
        // A re-resolved context whose generation moved is a re-fence: old
        // markers die with their generation before the refresh re-proves.
        setMarkerCache((current) => refenceStatusCache(current, context.generation))
        await loadDirectory(context, '')
        await refreshMarkers()
      }
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
        { worktreeId: context.worktreeId, limit: GIT_STATUS_LIMIT },
        { kind: 'worktree', id: context.worktreeId, generation: context.generation }
      )
      setMarkerCache(cacheStatus(markerMap(status.entries), context.generation))
      // `dev.git.status` has no cursor and the provider slices at `limit`, so
      // a worktree with more changed paths than that is silently partial: the
      // pane listed a subset and the tree dropped modification badges past it
      // with nothing said. Content search already states this, so say it here
      // too rather than presenting a partial set as the whole one.
      setStatusTruncated(status.entries.length >= GIT_STATUS_LIMIT)
    } catch {
      // Read-only pane, honest cache: a failed read publishes nothing — the
      // markers clear (a miss is a miss), never stale badges labeled fresh.
      setMarkerCache(invalidateStatus)
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

  async function searchContents(value: string): Promise<void> {
    const wanted = searchQuery(value)
    const context = worktree()
    const activeScope = scope()
    if (wanted === undefined || !context || !activeScope) {
      setContentRows([])
      setContentTruncated(false)
      setContentFailed(undefined)
      setContentQuery('')
      return
    }
    setContentQuery(wanted)
    setContentFailed(undefined)
    try {
      const page = await executeOperation<{
        items: readonly Parameters<typeof contentSearchRows>[0][number][]
        nextCursor?: string
      }>(
        props.runtime,
        activeScope,
        'dev.files.search',
        contentSearchBody(context.worktreeId, wanted),
        { kind: 'workspace_root', id: context.worktreeId, generation: context.generation }
      )
      setContentRows(contentSearchRows(page.items))
      setContentTruncated(page.nextCursor !== undefined)
    } catch (error) {
      // A refused search (no ripgrep on the node, a worktree that moved) says
      // what happened instead of looking like an empty result.
      setContentRows([])
      setContentTruncated(false)
      setContentFailed(describeError(error))
    }
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
    // Compare on `summary` — the path this plan was armed for — NOT on
    // `planId`. The provider mints `plan.id` as a UUID, so `planId` can never
    // equal a relative path, the guard was never satisfied on the second click,
    // and `commitPendingTree()` was unreachable: every Delete re-planned and no
    // directory was ever removed, while the button still relabelled to
    // "Confirm". The copy arm below already compared `summary` correctly.
    if (pendingTree()?.summary !== node.relativePath) {
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

  // The filter is a QUICK-OPEN jump, not a tree filter: the `<Show>` below
  // renders `fuzzyQuickOpen(loadedPaths(), filter())` whenever a query is typed,
  // so the tree rows are not on screen at all in that state. This used to also
  // build a filtered tree and a Set of every path in it on each keystroke —
  // an O(n) clone plus an O(n) set over the whole workspace, for a result that
  // was never rendered. With a query active the row list is only read for
  // `rowSlice().total`, which nothing displays while the list is hidden, so it
  // is measured from the unfiltered tree.
  const rows = createMemo(() => visibleRows(nodes(), expanded()))

  const rowSlice = createMemo(() =>
    rowWindow({
      pinIndex: focusedRow(),
      rowHeight: FILES_ROW_HEIGHT_PX,
      scrollTop: scrollTop(),
      total: rows().length,
      viewportHeight: viewportHeight(),
    })
  )
  const windowedRows = createMemo(() => rows().slice(rowSlice().start, rowSlice().end))

  /** Measures the scroll container; a pane that has never been measured still
   *  renders its first window, and this corrects it on the first frame. */
  function measureTree(): void {
    if (!treeElement) return
    setViewportHeight(treeElement.clientHeight)
    setScrollTop(treeElement.scrollTop)
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
      <Show when={contentQuery().length > 0}>
        <section class="dev-files__search" aria-label="Content search results">
          <div class="dev-files__search-head">
            <span role="status">
              {contentFailed() ?? matchSummary(contentRows(), contentTruncated())}
            </span>
            <button
              type="button"
              class="dev-files__search-clear"
              onClick={() => {
                setFilter('')
                void searchContents('')
              }}
            >
              Clear search
            </button>
          </div>
          <For each={contentRows()}>
            {(row) => (
              <button
                type="button"
                class="dev-files__search-row"
                title={matchLabel(row)}
                onClick={() =>
                  props.onOpenFile?.({
                    generation: worktree()?.generation ?? 0,
                    identity: row.identity,
                    relativePath: row.path.relativePath,
                    rootIdentity: row.path.rootIdentity,
                    worktreeId: row.path.worktreeId,
                  })
                }
              >
                <span class="dev-files__search-path">{matchLabel(row)}</span>
                <span class="dev-files__search-preview">
                  <For each={previewSegments(row)}>
                    {(segment) => (
                      <span class={cn({ 'dev-files__search-hit': segment.match })}>
                        {segment.text}
                      </span>
                    )}
                  </For>
                </span>
              </button>
            )}
          </For>
          <Show
            when={contentFailed() === undefined && contentRows().length === CONTENT_SEARCH_LIMIT}
          >
            <p class="dev-files__search-more">
              Only the first {CONTENT_SEARCH_LIMIT} matches are shown; narrow the query to see more.
            </p>
          </Show>
        </section>
      </Show>

      <div class="dev-files__toolbar">
        <input
          type="search"
          class="dev-files__filter"
          placeholder="Filter files"
          aria-label="Filter files"
          value={filter()}
          onInput={(event) => setFilter(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            void searchContents(event.currentTarget.value)
          }}
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
          <Show when={statusTruncated()}>
            <p class="dev-terminal-muted" role="status">
              Showing the first {GIT_STATUS_LIMIT} changed paths. This worktree has more, and
              modification markers past that are not shown.
            </p>
          </Show>
          <div
            ref={(element) => {
              treeElement = element
              // The first frame has no measured viewport; this corrects it
              // before the reader sees an unwindowed list.
              if (typeof requestAnimationFrame === 'function') requestAnimationFrame(measureTree)
            }}
            class="dev-files__tree"
            role="tree"
            aria-label="Worktree files"
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          >
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
              <div
                class="dev-files__window-pad"
                style={{ '--dev-files-pad': `${rowSlice().padTop}px` }}
                aria-hidden="true"
              />
              <For each={windowedRows()}>
                {(row) => (
                  <div
                    class={cn('dev-files__row', { 'dev-files__row--dir': row.hasChildren })}
                    data-depth={Math.min(row.depth, 8)}
                    onFocus={() =>
                      setFocusedRow(
                        rows().findIndex(
                          (candidate) => candidate.node.relativePath === row.node.relativePath
                        )
                      )
                    }
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
              <div
                class="dev-files__window-pad"
                style={{ '--dev-files-pad': `${rowSlice().padBottom}px` }}
                aria-hidden="true"
              />
            </Show>
          </div>
        </Show>
      </Show>
    </section>
  )
}

/** Matches the provider's page cap for `dev.git.status`. */
export const GIT_STATUS_LIMIT = 500

function flattenPaths(nodes: readonly FileTreeNode[]): readonly string[] {
  const paths: string[] = []
  for (const node of nodes) {
    if (node.kind === 'file') paths.push(node.relativePath)
    // Append in place rather than `paths.push(...recurse())`, which passes a
    // child's whole result as one call argument. Measured on this runtime the
    // spread form survives ~500k arguments and throws a RangeError by ~1M, so
    // this removes a distant ceiling rather than a routine one.
    const children = flattenPaths(node.children)
    for (const child of children) paths.push(child)
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
