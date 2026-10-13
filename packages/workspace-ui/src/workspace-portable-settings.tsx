import type { AgentHqApiClient, ApiPortableImportResult } from '@adea-ai/api-client'
import { useImportPortableWorkspaceMutation } from '@adea-ai/data'
import { SettingsRow } from '@adea-ai/ui/components/composites/settings'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Input } from '@adea-ai/ui/components/ui/input'
import { Check, Download, FileText, Upload, X } from 'lucide-solid'
import { createSignal, For, type JSX, Show } from 'solid-js'

import {
  countPortableRecords,
  describePortableFile,
  exportFailure,
  formatPortableBytes,
  type PortableFailure,
  type PortableFileSummary,
  portableCountLabels,
  OPEN_RESTORED_FAILURE,
  PORTABLE_MAX_BYTES,
  type PortableFileReading,
  readPortableFile,
  type RejectedFileReason,
  rejectedFileFailure,
  restoreFailure,
  savePortableFile,
} from './workspace-portable-model'

const EXPORT_DESCRIPTION =
  'Download a copy of this workspace as one file: what you can see of its conversations, projects, tasks and agents.'
const RESTORE_DESCRIPTION =
  'Restore a workspace from an Adea export file. It becomes a new workspace that you own.'

const INCLUDED = [
  'Projects and the people listed on them',
  'Conversations and messages you can read',
  'Tasks and their dependencies',
  'Agents and their public profiles',
  'People’s display names, as they are today',
] as const

const NOT_INCLUDED = [
  'Workspace members and roles',
  'Sign-in sessions, keys and other credentials',
  'File contents and message bodies kept only on a device; their records are included without the body',
  'Device, runtime and execution state',
  'Agents’ private context and memory',
  'Archived conversations and projects',
  'Private conversations and members-only projects you are not part of',
] as const

const RESTORE_EFFECTS = [
  'You become the owner. Members and roles are not restored; invite people afterwards.',
  'Everyone named in the file needs an account here already.',
  'Group conversations keep the people who were in them when the file was exported. If you weren’t one of them, you won’t see that history automatically.',
  'If this workspace already exists here, nothing is restored and nothing changes.',
] as const

const NOT_RESTORED = [
  'Members and roles: invite people to the new workspace',
  'Artifact files and device-only message bodies: their records are restored without the body',
  'Runtime and execution state, and agents’ private context',
] as const

function PointList(props: { icon: JSX.Element; items: readonly string[]; label: string }) {
  return (
    <div class="flex min-w-0 flex-col gap-2">
      <p class="text-muted-foreground text-xs font-medium uppercase">{props.label}</p>
      <ul class="flex flex-col gap-1.5">
        <For each={props.items}>
          {(item) => (
            <li class="flex items-start gap-2">
              <span class="text-muted-foreground mt-1 flex-none">{props.icon}</span>
              <span>{item}</span>
            </li>
          )}
        </For>
      </ul>
    </div>
  )
}

function FailureAlert(props: { failure: PortableFailure }) {
  return (
    <Alert variant={props.failure.tone}>
      <AlertDescription>{props.failure.message}</AlertDescription>
    </Alert>
  )
}

type ExportState =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'review' }>
  | Readonly<{ kind: 'preparing' }>
  | Readonly<{ kind: 'done'; bytes: number; fileName: string; records: number | undefined }>
  | Readonly<{ failure: PortableFailure; kind: 'failed' }>

/**
 * Downloads a portable copy of the workspace. The review step says what the file holds and what
 * it never does, because the server decides both from the requester's own access: the file is
 * what this person can see, not the whole workspace. Nothing is saved until the server has
 * answered, so a refusal leaves no partial file.
 */
export function WorkspaceExportSettings(props: {
  client: AgentHqApiClient
  workspace: Readonly<{ id: string }>
}) {
  const [state, setState] = createSignal<ExportState>({ kind: 'idle' })

  async function download() {
    if (state().kind === 'preparing') return
    // Captured at the click: a workspace switch while the export runs cannot retarget the file.
    const workspaceId = props.workspace.id
    setState({ kind: 'preparing' })
    try {
      const file = await props.client.exportWorkspace(workspaceId)
      savePortableFile(file.fileName, file.text)
      setState({
        bytes: file.bytes,
        fileName: file.fileName,
        kind: 'done',
        records: countPortableRecords(file.text),
      })
    } catch (failure) {
      setState({ failure: exportFailure(failure), kind: 'failed' })
    }
  }

  const done = () => {
    const current = state()
    return current.kind === 'done' ? current : undefined
  }
  const failed = () => {
    const current = state()
    return current.kind === 'failed' ? current : undefined
  }
  const trigger = (label = 'Export…', disabled = false) => (
    <Button variant="outline" disabled={disabled} onClick={() => setState({ kind: 'review' })}>
      <Download aria-hidden="true" />
      {label}
    </Button>
  )

  return (
    <Show
      when={state().kind === 'review' || state().kind === 'preparing'}
      fallback={
        <SettingsRow label="Export workspace" description={EXPORT_DESCRIPTION}>
          <div class="flex flex-col gap-2">
            <Show when={done()}>
              {(finished) => (
                <p role="status" class="flex items-center gap-2">
                  <Check aria-hidden="true" class="text-success" />
                  <span>
                    Downloaded {finished().fileName} ({formatPortableBytes(finished().bytes)}
                    {finished().records === undefined
                      ? ''
                      : `, ${finished().records?.toLocaleString('en-US')} records`}
                    ).
                  </span>
                </p>
              )}
            </Show>
            <Show when={failed()}>{(refused) => <FailureAlert failure={refused().failure} />}</Show>
            <div>
              {trigger(done() ? 'Export again' : 'Export…', failed()?.failure.final === true)}
            </div>
          </div>
        </SettingsRow>
      }
    >
      <SettingsRow label="Export workspace" description={EXPORT_DESCRIPTION} orientation="vertical">
        <div class="grid gap-6 sm:grid-cols-2">
          <PointList
            icon={<Check aria-hidden="true" class="size-3.5" />}
            items={INCLUDED}
            label="Included"
          />
          <PointList
            icon={<X aria-hidden="true" class="size-3.5" />}
            items={NOT_INCLUDED}
            label="Not included"
          />
        </div>
        <p class="text-muted-foreground">
          Exports up to 10,000 records or 8 MB. Larger workspaces can’t be exported yet.
        </p>
        <div class="flex items-center gap-2">
          <Button
            disabled={state().kind === 'preparing'}
            aria-busy={state().kind === 'preparing'}
            onClick={() => void download()}
          >
            <Download aria-hidden="true" />
            {state().kind === 'preparing' ? 'Preparing export…' : 'Download export'}
          </Button>
          <Button
            variant="outline"
            disabled={state().kind === 'preparing'}
            onClick={() => setState({ kind: 'idle' })}
          >
            Cancel
          </Button>
        </div>
      </SettingsRow>
    </Show>
  )
}

type RestoreState =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ fileName: string; kind: 'reading' }>
  | Readonly<{ failure: PortableFailure; kind: 'rejected' }>
  | Readonly<{
      bytes: number
      failure?: PortableFailure
      fileName: string
      kind: 'review' | 'restoring'
      summary: PortableFileSummary
      text: string
    }>
  | Readonly<{ kind: 'done'; result: ApiPortableImportResult; workspaceName: string }>

/**
 * Restores a portable export as a new workspace the caller owns. The file is read in the browser
 * only to show what is about to be restored; the server validates it, checks its digest and
 * refuses anything it cannot restore whole, so a refusal never leaves a partial workspace.
 */
export function WorkspaceRestoreSettings(props: {
  client: AgentHqApiClient
  /** Takes the user into the restored workspace; without it the result offers only Done. */
  onOpenWorkspace?: (workspaceId: string) => Promise<boolean>
}) {
  const importPortable = useImportPortableWorkspaceMutation(props.client)
  const [state, setState] = createSignal<RestoreState>({ kind: 'idle' })
  const [picker, setPicker] = createSignal<HTMLInputElement>()
  const [opening, setOpening] = createSignal(false)
  const [openFailure, setOpenFailure] = createSignal(false)
  // Bumped whenever a read starts or is cancelled, so a read that finishes late is dropped
  // instead of replacing the file the person chose after it or the Cancel they pressed.
  let readToken = 0

  async function choose(file: File | undefined) {
    if (!file || state().kind === 'restoring') return
    const token = ++readToken
    setState({ fileName: file.name, kind: 'reading' })
    let reading: PortableFileReading | { ok: false; reason: RejectedFileReason }
    try {
      // The size is checked before the file is read, so an oversized file never loads into memory.
      reading =
        file.size > PORTABLE_MAX_BYTES
          ? { ok: false, reason: 'too_large' }
          : readPortableFile(await file.text(), file.size)
    } catch {
      reading = { ok: false, reason: 'unreadable' }
    }
    if (token !== readToken) return
    if (!reading.ok) setState({ failure: rejectedFileFailure(reading.reason), kind: 'rejected' })
    else
      setState({
        bytes: file.size,
        fileName: file.name,
        kind: 'review',
        summary: reading.summary,
        text: reading.text,
      })
  }

  function cancelReading() {
    readToken += 1
    setState({ kind: 'idle' })
  }

  async function open(workspaceId: string, onOpen: (workspaceId: string) => Promise<boolean>) {
    if (opening()) return
    setOpening(true)
    setOpenFailure(false)
    try {
      // On success the dialog closes and this row goes away with it.
      if (!(await onOpen(workspaceId))) setOpenFailure(true)
    } catch {
      setOpenFailure(true)
    } finally {
      setOpening(false)
    }
  }

  async function restore() {
    const current = state()
    if ((current.kind !== 'review' && current.kind !== 'restoring') || importPortable.isPending)
      return
    readToken += 1
    setState({ ...current, failure: undefined, kind: 'restoring' })
    try {
      const result = await importPortable.mutateAsync(current.text)
      setOpenFailure(false)
      setState({ kind: 'done', result, workspaceName: current.summary.workspaceName })
    } catch (failure) {
      setState({ ...current, failure: restoreFailure(failure), kind: 'review' })
    }
  }

  const reviewing = () => {
    const current = state()
    return current.kind === 'review' || current.kind === 'restoring' ? current : undefined
  }
  const finished = () => {
    const current = state()
    return current.kind === 'done' ? current : undefined
  }
  const reading = () => {
    const current = state()
    return current.kind === 'reading' ? current : undefined
  }
  const rejected = () => {
    const current = state()
    return current.kind === 'rejected' ? current : undefined
  }

  return (
    <>
      <Input
        ref={setPicker}
        type="file"
        accept=".json,application/json"
        class="sr-only"
        tabIndex={-1}
        aria-label="Export file to restore"
        onChange={(event) => {
          const input = event.currentTarget
          const file = input.files?.[0]
          // Cleared so choosing the same file again after a refusal still fires.
          input.value = ''
          void choose(file)
        }}
      />
      <Show
        when={reviewing() ?? finished() ?? reading()}
        fallback={
          <SettingsRow label="Restore from export" description={RESTORE_DESCRIPTION}>
            <div class="flex flex-col gap-2">
              <Show when={rejected()}>
                {(refused) => <FailureAlert failure={refused().failure} />}
              </Show>
              <div>
                <Button variant="outline" onClick={() => picker()?.click()}>
                  <Upload aria-hidden="true" />
                  Choose export file…
                </Button>
              </div>
            </div>
          </SettingsRow>
        }
      >
        <SettingsRow
          label="Restore from export"
          description={RESTORE_DESCRIPTION}
          orientation="vertical"
        >
          <Show when={reading()}>
            {(current) => (
              <>
                <div
                  role="status"
                  class="border-border bg-card flex items-center gap-3 rounded-lg border px-3 py-2"
                >
                  <FileText aria-hidden="true" class="text-muted-foreground flex-none" />
                  <div class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate font-medium">{current().fileName}</span>
                    <span class="text-muted-foreground text-xs">Reading file…</span>
                  </div>
                </div>
                <div>
                  <Button variant="outline" onClick={cancelReading}>
                    Cancel
                  </Button>
                </div>
              </>
            )}
          </Show>
          <Show when={reviewing()}>
            {(current) => (
              <>
                <div class="border-border bg-card flex items-center gap-3 rounded-lg border px-3 py-2">
                  <FileText aria-hidden="true" class="text-muted-foreground flex-none" />
                  <div class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate font-medium">{current().fileName}</span>
                    <span class="text-muted-foreground text-xs">
                      {describePortableFile(current().summary, current().bytes)}
                    </span>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={current().kind === 'restoring'}
                    onClick={() => picker()?.click()}
                  >
                    Choose another
                  </Button>
                </div>
                <div class="flex flex-col gap-2">
                  <p>
                    Restore <strong>{current().summary.workspaceName}</strong> as a workspace you
                    own?
                  </p>
                  <div class="flex flex-wrap gap-1.5">
                    <For each={portableCountLabels(current().summary.counts)}>
                      {(label) => <Badge variant="secondary">{label}</Badge>}
                    </For>
                  </div>
                </div>
                <PointList
                  icon={<Check aria-hidden="true" class="size-3.5" />}
                  label="What happens"
                  items={RESTORE_EFFECTS}
                />
                <Show when={current().failure}>
                  {(failure) => <FailureAlert failure={failure()} />}
                </Show>
                <div class="flex items-center gap-2">
                  <Button
                    disabled={current().kind === 'restoring'}
                    aria-busy={current().kind === 'restoring'}
                    onClick={() => void restore()}
                  >
                    <Upload aria-hidden="true" />
                    {current().kind === 'restoring' ? 'Restoring…' : 'Restore workspace'}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={current().kind === 'restoring'}
                    onClick={() => setState({ kind: 'idle' })}
                  >
                    Cancel
                  </Button>
                </div>
              </>
            )}
          </Show>
          <Show when={finished()}>
            {(current) => (
              <>
                <p role="status" class="flex items-start gap-2">
                  <Check aria-hidden="true" class="text-success mt-0.5 flex-none" />
                  <span>
                    <strong>{current().workspaceName}</strong> is restored and you own it.
                  </span>
                </p>
                <div class="flex flex-wrap gap-1.5">
                  <For each={portableCountLabels(current().result.counts)}>
                    {(label) => <Badge variant="secondary">{label}</Badge>}
                  </For>
                </div>
                <PointList
                  icon={<X aria-hidden="true" class="size-3.5" />}
                  label="Not restored"
                  items={NOT_RESTORED}
                />
                <Show when={openFailure()}>
                  <FailureAlert failure={OPEN_RESTORED_FAILURE} />
                </Show>
                <div class="flex items-center gap-2">
                  <Show when={props.onOpenWorkspace}>
                    {(onOpen) => (
                      <Button
                        disabled={opening()}
                        aria-busy={opening()}
                        onClick={() => void open(current().result.workspaceId, onOpen())}
                      >
                        {opening() ? 'Opening…' : 'Open workspace'}
                      </Button>
                    )}
                  </Show>
                  <Button variant="outline" onClick={() => setState({ kind: 'idle' })}>
                    Done
                  </Button>
                </div>
              </>
            )}
          </Show>
        </SettingsRow>
      </Show>
    </>
  )
}
