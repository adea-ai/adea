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
import { createProjectFolderPicker } from './project-folder-picker'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Checkbox } from '@adea-ai/ui/components/ui/checkbox'
import { Input } from '@adea-ai/ui/components/ui/input'
import { Label } from '@adea-ai/ui/components/ui/label'
import { NativeSelect } from '@adea-ai/ui/components/ui/native-select'
import { Text } from '@adea-ai/ui/components/ui/typography'

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
  /**
   * The host's native folder picker; when present the authorize step offers
   * "Choose folder…" and fills the path input from the picked folder. The
   * typed input remains the fallback, and the picked path still goes through
   * `dev.project.authorizeRoot` — the picker only fills the field, it never
   * widens authorization.
   */
  pickFolder?: () => Promise<string | null | undefined>
  /**
   * A path to fill the folder input with, for a caller that already has one
   * (a typed directory from project settings). It is only a prefill: the path
   * still goes through `dev.project.authorizeRoot` when the member authorizes it.
   */
  initialPath?: string
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
  // The native picker is composed as its own unit: a cancelled or failed pick
  // leaves the typed path untouched, a repeated request is ignored while one is
  // in flight, and a completion that arrives after this form was torn down
  // changes nothing.
  const picker = createProjectFolderPicker({ pickFolder: () => props.pickFolder?.() })
  if (props.initialPath) picker.setPath(props.initialPath)
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

  /** Fills the path input from the host's native picker. A cancelled or
   *  failed pick leaves the typed value untouched. */
  const chooseFolder = async (): Promise<void> => picker.choose()

  /** Authorize one absolute host path as a project root, then scan it. The
   *  runtime proves owner consent host-side over the scope-bound channel;
   *  this form only presents the path and the resulting previews. */
  const authorizeFolder = async (): Promise<void> => {
    const absolutePath = picker.path().trim()
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
    picker.setPath('')
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
    <div class="flex flex-col gap-2">
      <div role="group" aria-label="Authorize a project folder" class="flex flex-col gap-2">
        <Text as="p" variant="caption" tone="muted">
          Authorize a folder on this machine, then import the projects found inside it.
        </Text>
        <div>
          <Label class="w-full">
            <span class="sr-only">Folder path to authorize</span>
            <Input
              type="text"
              value={picker.path()}
              placeholder="/absolute/path/to/project"
              onInput={(event) => picker.setPath(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void authorizeFolder()
              }}
            />
          </Label>
        </div>
        <Show when={authorizeError()}>
          <Alert variant="destructive">
            <AlertDescription>{authorizeError()}</AlertDescription>
          </Alert>
        </Show>
        <div class="flex flex-wrap items-center gap-2">
          <Show when={props.pickFolder}>
            <Button
              type="button"
              variant="outline"
              disabled={picker.picking()}
              onClick={() => void chooseFolder()}
            >
              <FolderPlus aria-hidden="true" />
              {picker.picking() ? 'Choosing…' : 'Choose folder…'}
            </Button>
          </Show>
          <Button
            type="button"
            variant="outline"
            disabled={authorizing() || picker.path().trim() === ''}
            onClick={() => void authorizeFolder()}
          >
            <FolderPlus aria-hidden="true" />
            {authorizing() ? 'Authorizing…' : 'Authorize folder'}
          </Button>
        </div>
      </div>
      <Show when={bookmarksError()}>
        <Alert variant="destructive">
          <AlertDescription>{bookmarksError()}</AlertDescription>
        </Alert>
      </Show>
      <Show when={!bookmarksError()}>
        <Show
          when={bookmarks().length > 0}
          fallback={
            <Text as="p" variant="caption" tone="muted">
              No authorized roots yet. An authorized folder is listed here for scanning.
            </Text>
          }
        >
          <div>
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
          </div>
        </Show>
        <Show when={scan().status === 'scanning'}>
          <Text as="p" variant="caption" tone="muted" role="status">
            Scanning under the authorized root…
          </Text>
        </Show>
        <Show when={scan().status === 'failed'}>
          <Alert variant="destructive">
            <AlertDescription>
              {(scan() as { status: 'failed'; message: string }).message}
            </AlertDescription>
          </Alert>
        </Show>
        <Show when={readyScan()}>
          <div
            role="group"
            aria-label="Scan results requiring confirmation"
            class="flex flex-col gap-2"
          >
            <Show when={readyScan()?.notice}>
              <Text as="p" variant="caption" tone="muted" role="status">
                {readyScan()?.notice}
              </Text>
            </Show>
            <For each={readyScan()?.rows}>
              {(row) => (
                <div>
                  <Checkbox
                    class="w-full"
                    disabled={row.duplicate}
                    checked={confirmed().has(row.entry.relativeDir)}
                    label={
                      <>
                        <span>{row.entry.name}</span>
                        <Show when={row.duplicate}>
                          {' '}
                          <Badge
                            size="sm"
                            variant="warning"
                            title="A project with this name already exists"
                          >
                            dup
                          </Badge>
                        </Show>
                      </>
                    }
                    description={row.entry.packageManager}
                    onChange={(checked: boolean) => toggleConfirmed(row.entry.relativeDir, checked)}
                  />
                </div>
              )}
            </For>
            <Button
              type="button"
              variant="outline"
              disabled={importing()}
              onClick={() => void importConfirmed()}
            >
              Import confirmed packages
            </Button>
          </div>
        </Show>
      </Show>
    </div>
  )
}
