/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0.
 *
 * Add/search surface for the contextual sidebar (#398): recent authorized
 * roots, bounded monorepo scan previews, and a confirm-before-import flow.
 * Composition follows the add flows substantially translated from KiroCrew's
 * ChatSidebar and Orca's AddRepoDialog (donor audit #398), rebuilt for Solid,
 * Adea tokens, and the authority boundary: this component issues only
 * `dev.project.bookmarks`, `dev.project.scan`, `dev.group.list`,
 * `dev.group.create`, and `dev.project.import` commands. Scan results are
 * previews requiring confirmation; nothing here ever executes
 * install/bootstrap commands.
 */
import type {
  DevCommand,
  DevOperation,
  DevReply,
  ProjectScanEntry,
  Scope,
} from '@adea-ai/types/dev-runtime'
import { For, Show, createSignal, onMount } from 'solid-js'

import { buildDevCommand } from '../browser/command'
import {
  bookmarkRows,
  importBodyFor,
  importableRows,
  scanNotice,
  scanPreviews,
  type ScanBookmarkRow,
  type ScanPreviewRow,
} from './scan-preview-model'

export type AddProjectPanelProps = Readonly<{
  scope: Scope
  execute(command: DevCommand): Promise<DevReply>
  /** Names of live projects, for the duplicate preview state. */
  knownProjectNames: readonly string[]
  onImported(): void
  announce(message: string): void
}>

type ScanState =
  | Readonly<{ status: 'idle' }>
  | Readonly<{ status: 'scanning' }>
  | Readonly<{ status: 'failed'; message: string }>
  | Readonly<{
      status: 'ready'
      rootBookmarkId: string
      rows: readonly ScanPreviewRow[]
      notice?: string
    }>

export function AddProjectPanel(props: AddProjectPanelProps) {
  const [bookmarks, setBookmarks] = createSignal<readonly ScanBookmarkRow[]>([])
  const [bookmarksError, setBookmarksError] = createSignal('')
  const [selectedBookmarkId, setSelectedBookmarkId] = createSignal('')
  const [scan, setScan] = createSignal<ScanState>({ status: 'idle' })
  const [confirmed, setConfirmed] = createSignal<ReadonlySet<string>>(new Set<string>())
  const [targetGroupId, setTargetGroupId] = createSignal('')
  const [newGroupName, setNewGroupName] = createSignal('')
  const [groups, setGroups] = createSignal<readonly { id: string; name: string }[]>([])
  const [importing, setImporting] = createSignal(false)

  /** Narrowed accessor for the ready scan; Show keys off its truthiness. */
  const readyScan = () => {
    const state = scan()
    return state.status === 'ready' ? state : undefined
  }

  const buildCommand = (operation: DevOperation, body: Record<string, unknown>): DevCommand =>
    buildDevCommand({ operation, scope: props.scope, body })

  const run = async (command: DevCommand): Promise<DevReply> => props.execute(command)

  onMount(() => {
    void (async () => {
      const bookmarksReply = await run(buildCommand('dev.project.bookmarks', {})).catch(
        () => undefined
      )
      if (!bookmarksReply) {
        setBookmarksError('Authorized roots are unavailable on this runtime.')
        return
      }
      if (!bookmarksReply.ok) {
        setBookmarksError(`Authorized roots are unavailable: ${bookmarksReply.error.message}`)
        return
      }
      const page = bookmarksReply.value as { items: readonly Record<string, unknown>[] }
      setBookmarks(bookmarkRows(page.items))
      const groupsReply = await run(buildCommand('dev.group.list', {})).catch(() => undefined)
      if (groupsReply?.ok) {
        const groupPage = groupsReply.value as { items: readonly Record<string, unknown>[] }
        setGroups(
          groupPage.items.flatMap((raw) =>
            typeof raw.id === 'string' && typeof raw.name === 'string'
              ? [{ id: raw.id, name: raw.name }]
              : []
          )
        )
      }
    })()
  })

  const requestScan = async (rootBookmarkId: string) => {
    setScan({ status: 'scanning' })
    setConfirmed(new Set<string>())
    const reply = await run(buildCommand('dev.project.scan', { rootBookmarkId }))
    if (!reply.ok) {
      setScan({ status: 'failed', message: reply.error.message })
      return
    }
    const page = reply.value as {
      rootBookmarkId: string
      items: readonly ProjectScanEntry[]
      diagnostics: readonly string[]
    }
    const rows = scanPreviews({ items: page.items }, props.knownProjectNames)
    const notice = scanNotice(page.diagnostics ?? [])
    setScan({
      status: 'ready',
      rootBookmarkId: page.rootBookmarkId,
      rows,
      ...(notice ? { notice } : {}),
    })
  }

  const toggleConfirmed = (relativeDir: string, checked: boolean) => {
    setConfirmed((current) => {
      const next = new Set(current)
      if (checked) next.add(relativeDir)
      else next.delete(relativeDir)
      return next
    })
  }

  const resolveTargetGroup = async (): Promise<string | undefined> => {
    const existing = targetGroupId()
    if (existing !== '') return existing
    const name = newGroupName().trim()
    if (name === '') {
      props.announce('Choose a group for the import, or name a new one.')
      return undefined
    }
    const reply = await run(buildCommand('dev.group.create', { name }))
    if (!reply.ok) {
      props.announce(`Group creation was refused: ${reply.error.message}`)
      return undefined
    }
    const group = reply.value as { id: string }
    setGroups((current) => [...current, { id: group.id, name }])
    setTargetGroupId(group.id)
    setNewGroupName('')
    return group.id
  }

  const importConfirmed = async () => {
    const state = scan()
    if (state.status !== 'ready' || importing()) return
    const groupId = await resolveTargetGroup()
    if (groupId === undefined) return
    const rootBookmarkId = state.rootBookmarkId
    const rows = importableRows(state.rows).filter((row) => confirmed().has(row.entry.relativeDir))
    if (rows.length === 0) {
      props.announce('No importable rows are confirmed.')
      return
    }
    setImporting(true)
    let imported = 0
    const failures: string[] = []
    for (const row of rows) {
      const reply = await run(
        buildCommand('dev.project.import', importBodyFor(row, rootBookmarkId, [groupId]))
      )
      if (reply.ok) imported += 1
      else failures.push(`${row.entry.name}: ${reply.error.message}`)
    }
    setImporting(false)
    if (failures.length > 0) props.announce(`Import finished with refusals: ${failures.join('; ')}`)
    else props.announce(`Imported ${imported} project${imported === 1 ? '' : 's'}.`)
    if (imported > 0) {
      props.onImported()
      setScan({ status: 'idle' })
      setConfirmed(new Set<string>())
    }
  }

  return (
    <details class="dev-tree-group">
      <summary class="dev-tree-row dev-tree-row--group">Add project</summary>
      <Show when={bookmarksError()}>
        <p class="dev-tree-empty" role="alert">
          {bookmarksError()}
        </p>
      </Show>
      <Show when={!bookmarksError()}>
        <Show
          when={bookmarks().length > 0}
          fallback={
            <p class="dev-tree-empty">No authorized roots yet. Authorize a folder first.</p>
          }
        >
          <p class="dev-tree-empty">
            <label>
              <span class="sr-only">Authorized root to scan</span>
              <select
                value={selectedBookmarkId()}
                onChange={(event) => {
                  const id = event.currentTarget.value
                  setSelectedBookmarkId(id)
                  if (id !== '') void requestScan(id)
                }}
              >
                <option value="">Scan an authorized root…</option>
                <For each={bookmarks()}>
                  {(bookmark) => (
                    <option value={bookmark.id}>
                      {bookmark.label} ({bookmark.kind})
                    </option>
                  )}
                </For>
              </select>
            </label>
          </p>
        </Show>
        <Show when={scan().status === 'scanning'}>
          <p class="dev-tree-empty" role="status">
            Scanning under the authorized root…
          </p>
        </Show>
        <Show when={scan().status === 'failed'}>
          <p class="dev-tree-empty" role="alert">
            {(scan() as { status: 'failed'; message: string }).message}
          </p>
        </Show>
        <Show when={readyScan()}>
          <div role="group" aria-label="Scan results requiring confirmation">
            <Show when={readyScan()?.notice}>
              <p class="dev-tree-empty" role="status">
                {readyScan()?.notice}
              </p>
            </Show>
            <For each={readyScan()?.rows}>
              {(row) => (
                <label class="dev-tree-row dev-tree-row--project">
                  <input
                    type="checkbox"
                    disabled={row.duplicate}
                    checked={confirmed().has(row.entry.relativeDir)}
                    onChange={(event) =>
                      toggleConfirmed(row.entry.relativeDir, event.currentTarget.checked)
                    }
                  />
                  <span>{row.entry.name}</span>
                  <span class="dev-tree-row__count">{row.entry.packageManager}</span>
                  <Show when={row.duplicate}>
                    <span class="dev-row-badge" title="A project with this name already exists">
                      dup
                    </span>
                  </Show>
                </label>
              )}
            </For>
            <p class="dev-tree-empty">Group</p>
            <label class="dev-tree-row dev-tree-row--project">
              <span class="sr-only">Import into group</span>
              <select
                value={targetGroupId()}
                onChange={(event) => setTargetGroupId(event.currentTarget.value)}
              >
                <option value="">New group…</option>
                <For each={groups()}>
                  {(group) => <option value={group.id}>{group.name}</option>}
                </For>
              </select>
            </label>
            <Show when={targetGroupId() === ''}>
              <label class="dev-tree-row dev-tree-row--project">
                <span class="sr-only">New group name</span>
                <input
                  type="text"
                  value={newGroupName()}
                  placeholder="New group name"
                  onInput={(event) => setNewGroupName(event.currentTarget.value)}
                />
              </label>
            </Show>
            <button
              type="button"
              class="dev-button dev-button--secondary"
              disabled={importing()}
              onClick={() => void importConfirmed()}
            >
              Import confirmed packages
            </button>
          </div>
        </Show>
      </Show>
    </details>
  )
}
