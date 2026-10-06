/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0.
 *
 * Add/search surface for binding a repository (#398, ADR 0011): recent authorized
 * roots, bounded monorepo scan previews, and a confirm-before-import flow.
 * Composition follows the add flows substantially translated from KiroCrew's
 * ChatSidebar and Orca's AddRepoDialog (donor audit #398), rebuilt for Solid,
 * Adea tokens, and the authority boundary: this component issues only
 * `dev.project.bookmarks`, `dev.project.authorizeRoot`, `dev.project.scan`,
 * and `dev.project.import` commands. Each import binds the cloud project id
 * the host supplies (`mintProjectId`). Scan results are previews requiring
 * confirmation; nothing here ever executes install/bootstrap commands.
 */
import type {
  DevCommand,
  DevOperation,
  DevReply,
  ProjectScanEntry,
  Scope,
} from '@adea-ai/types/dev-runtime'
import { For, Show, createSignal, onMount } from 'solid-js'
import { FolderPlus } from 'lucide-solid'

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
import { Button } from '@adea-ai/ui/components/ui/button'
import { Checkbox } from '@adea-ai/ui/components/ui/checkbox'
import { Input } from '@adea-ai/ui/components/ui/input'
import { Label } from '@adea-ai/ui/components/ui/label'
import { NativeSelect } from '@adea-ai/ui/components/ui/native-select'

export type AddProjectFormProps = Readonly<{
  scope: Scope
  execute(command: DevCommand): Promise<DevReply>
  /** Names of live projects, for the duplicate preview state. */
  knownProjectNames: readonly string[]
  onImported(): void
  announce(message: string): void
  /**
   * Supplies the cloud project id each import binds. The register keys every
   * binding by a cloud project id and never mints one itself; the Dev
   * sidebar passes the project being bound. The default mints a client UUID.
   */
  mintProjectId?: () => string
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

export function AddProjectForm(props: AddProjectFormProps) {
  const [bookmarks, setBookmarks] = createSignal<readonly ScanBookmarkRow[]>([])
  const [bookmarksError, setBookmarksError] = createSignal('')
  const [selectedBookmarkId, setSelectedBookmarkId] = createSignal('')
  const [folderPath, setFolderPath] = createSignal('')
  const [authorizing, setAuthorizing] = createSignal(false)
  const [authorizeError, setAuthorizeError] = createSignal('')
  const [scan, setScan] = createSignal<ScanState>({ status: 'idle' })
  const [confirmed, setConfirmed] = createSignal<ReadonlySet<string>>(new Set<string>())
  const [importing, setImporting] = createSignal(false)

  /** Narrowed accessor for the ready scan; Show keys off its truthiness. */
  const readyScan = () => {
    const state = scan()
    return state.status === 'ready' ? state : undefined
  }

  const buildCommand = (operation: DevOperation, body: Record<string, unknown>): DevCommand =>
    buildDevCommand({ operation, scope: props.scope, body })

  const run = async (command: DevCommand): Promise<DevReply> => props.execute(command)

  const loadBookmarks = async (): Promise<void> => {
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
    setBookmarksError('')
  }

  onMount(() => {
    void loadBookmarks()
  })

  const mintProjectId = () => props.mintProjectId?.() ?? crypto.randomUUID()

  /** Authorize one absolute host path as a project root, then scan it. The
   *  runtime proves owner consent host-side over the scope-bound channel;
   *  this form only presents the path and the resulting previews. */
  const authorizeFolder = async (): Promise<void> => {
    const absolutePath = folderPath().trim()
    if (absolutePath === '' || authorizing()) return
    setAuthorizing(true)
    setAuthorizeError('')
    const reply = await run(buildCommand('dev.project.authorizeRoot', { absolutePath }))
    setAuthorizing(false)
    if (!reply.ok) {
      setAuthorizeError(reply.error.message)
      return
    }
    const record = reply.value as { id: string; label: string }
    setFolderPath('')
    props.announce(`Authorized ${record.label}. Scanning it for projects…`)
    await loadBookmarks()
    setSelectedBookmarkId(record.id)
    await requestScan(record.id)
  }

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

  const importConfirmed = async () => {
    const state = scan()
    if (state.status !== 'ready' || importing()) return
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
        buildCommand('dev.project.import', importBodyFor(rootBookmarkId, mintProjectId()))
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
    <>
      <div role="group" aria-label="Authorize a project folder">
        <p class="dev-tree-empty">
          Authorize a folder on this machine, then import the projects found inside it.
        </p>
        <Label class="dev-tree-row dev-tree-row--project">
          <span class="sr-only">Folder path to authorize</span>
          <Input
            type="text"
            value={folderPath()}
            placeholder="/absolute/path/to/project"
            onInput={(event) => setFolderPath(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void authorizeFolder()
            }}
          />
        </Label>
        <Show when={authorizeError()}>
          <p class="dev-tree-empty" role="alert">
            {authorizeError()}
          </p>
        </Show>
        <Button
          type="button"
          class="dev-button dev-button--secondary"
          disabled={authorizing() || folderPath().trim() === ''}
          onClick={() => void authorizeFolder()}
        >
          <FolderPlus aria-hidden="true" />
          {authorizing() ? 'Authorizing…' : 'Authorize folder'}
        </Button>
      </div>
      <Show when={bookmarksError()}>
        <p class="dev-tree-empty" role="alert">
          {bookmarksError()}
        </p>
      </Show>
      <Show when={!bookmarksError()}>
        <Show
          when={bookmarks().length > 0}
          fallback={
            <p class="dev-tree-empty">
              No authorized roots yet. An authorized folder is listed here for scanning.
            </p>
          }
        >
          <p class="dev-tree-empty">
            <Label>
              <span class="sr-only">Authorized root to scan</span>
              <NativeSelect
                value={selectedBookmarkId()}
                onChange={(event) => {
                  const id = event.currentTarget.value
                  setSelectedBookmarkId(id)
                  if (id !== '') void requestScan(id)
                }}
                options={[
                  { value: '', label: 'Scan an authorized root…' },
                  ...bookmarks().map((bookmark) => ({
                    value: bookmark.id,
                    label: `${bookmark.label} (${bookmark.kind})`,
                  })),
                ]}
              />
            </Label>
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
                <Checkbox
                  class="dev-tree-row dev-tree-row--project"
                  disabled={row.duplicate}
                  checked={confirmed().has(row.entry.relativeDir)}
                  label={
                    <>
                      <span>{row.entry.name}</span>
                      <span class="dev-tree-row__count">{row.entry.packageManager}</span>
                      <Show when={row.duplicate}>
                        <span class="dev-row-badge" title="A project with this name already exists">
                          dup
                        </span>
                      </Show>
                    </>
                  }
                  onChange={(checked: boolean) => toggleConfirmed(row.entry.relativeDir, checked)}
                />
              )}
            </For>
            <Button
              type="button"
              class="dev-button dev-button--secondary"
              disabled={importing()}
              onClick={() => void importConfirmed()}
            >
              Import confirmed packages
            </Button>
          </div>
        </Show>
      </Show>
    </>
  )
}
