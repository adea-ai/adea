// Workspace settings › Memory (ADR 0012). Lists the authorized workspace's
// memory notes, adds/edits/deletes them, resolves agent proposals, and owns
// the per-workspace launch-injection switch. Every mutation goes through the
// desktop store's trusted command family; without a desktop shell the pane
// renders its typed unavailable state instead of fixture data.
import type { WorkspaceMemoryEntry } from '@adea-ai/types'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { SettingsRow } from '@adea-ai/ui/components/composites/settings'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@adea-ai/ui/components/ui/empty'
import { FormField } from '@adea-ai/ui/components/ui/field'
import { ItemGroup, ItemGroupEntry } from '@adea-ai/ui/components/ui/item'
import { Switch } from '@adea-ai/ui/components/ui/switch'
import { Textarea } from '@adea-ai/ui/components/ui/textarea'
import { Pencil, Trash2 } from 'lucide-solid'
import { createEffect, createSignal, For, on, onCleanup, Show } from 'solid-js'

import {
  MEMORY_ENTRY_MAX_CHARS,
  MEMORY_UNAVAILABLE_COPY,
  memoryDateLabel,
  memoryDraftError,
  memoryErrorCode,
  memoryErrorMessage,
  memoryErrorNeedsRefresh,
  memorySourceLabel,
  memoryView,
  type MemoryErrorCode,
  type MemoryView,
} from './memory-model'
import type { WorkspaceMemoryService } from './platform'

type LoadState =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'ready'; view: MemoryView }>
  | Readonly<{ kind: 'refused'; code: MemoryErrorCode }>

export function MemoryPane(props: { service?: WorkspaceMemoryService; workspaceId: string }) {
  return (
    <Show
      when={props.service}
      fallback={
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Memory is unavailable here</EmptyTitle>
            <EmptyDescription role="status">{MEMORY_UNAVAILABLE_COPY}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      }
    >
      {(service) => <MemoryManager service={service()} workspaceId={props.workspaceId} />}
    </Show>
  )
}

function MemoryManager(props: { service: WorkspaceMemoryService; workspaceId: string }) {
  const [state, setState] = createSignal<LoadState>({ kind: 'loading' })
  const [draft, setDraft] = createSignal('')
  const [draftTouched, setDraftTouched] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [notice, setNotice] = createSignal<string | null>(null)
  const [editing, setEditing] = createSignal<{ id: string; text: string } | null>(null)
  let disposed = false
  let request = 0
  onCleanup(() => {
    disposed = true
  })

  async function refresh() {
    const current = ++request
    try {
      const snapshot = await props.service.list(props.workspaceId)
      if (disposed || current !== request) return
      setState({ kind: 'ready', view: memoryView(snapshot, props.workspaceId) })
    } catch (error) {
      if (disposed || current !== request) return
      setState({ kind: 'refused', code: memoryErrorCode(error) })
    }
  }

  createEffect(
    on(
      () => props.workspaceId,
      () => {
        setState({ kind: 'loading' })
        setEditing(null)
        setNotice(null)
        void refresh()
      }
    )
  )

  async function mutate(run: () => Promise<unknown>, success?: () => void) {
    if (busy()) return
    setBusy(true)
    setNotice(null)
    try {
      await run()
      success?.()
      await refresh()
    } catch (error) {
      const code = memoryErrorCode(error)
      if (!disposed) setNotice(memoryErrorMessage(code))
      if (memoryErrorNeedsRefresh(code)) await refresh()
    } finally {
      if (!disposed) setBusy(false)
    }
  }

  const draftError = () => (draftTouched() ? memoryDraftError(draft()) : undefined)

  function addNote() {
    setDraftTouched(true)
    if (memoryDraftError(draft())) return
    void mutate(
      () => props.service.create({ workspaceId: props.workspaceId, text: draft().trim() }),
      () => {
        setDraft('')
        setDraftTouched(false)
      }
    )
  }

  function saveEdit(entry: WorkspaceMemoryEntry) {
    const current = editing()
    if (!current || memoryDraftError(current.text)) return
    void mutate(
      () =>
        props.service.update({
          workspaceId: props.workspaceId,
          entryId: entry.id,
          expectedRevision: entry.revision,
          text: current.text.trim(),
        }),
      () => setEditing(null)
    )
  }

  function entryRef(entry: WorkspaceMemoryEntry) {
    return {
      workspaceId: props.workspaceId,
      entryId: entry.id,
      expectedRevision: entry.revision,
    }
  }

  return (
    <Show
      when={state().kind !== 'refused'}
      fallback={
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Memory is unavailable</EmptyTitle>
            <EmptyDescription role="status">
              {memoryErrorMessage(
                (state() as { code: MemoryErrorCode }).code ?? 'memory_unavailable'
              )}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      }
    >
      <div class="workspace-memory">
        <Show
          when={state().kind === 'ready' ? (state() as { view: MemoryView }).view : undefined}
          fallback={<p class="conventional-settings-note">Loading memory…</p>}
        >
          {(view) => (
            <>
              <SettingsRow
                label="Use memory in new agent sessions"
                description="Agents launched in this workspace start with its memory notes, newest first. Turning this off keeps every note."
              >
                <Switch
                  checked={view().injectionEnabled}
                  disabled={busy()}
                  onChange={() =>
                    void mutate(() =>
                      props.service.setInjectionEnabled({
                        workspaceId: props.workspaceId,
                        enabled: !view().injectionEnabled,
                      })
                    )
                  }
                  aria-label="Use memory in new agent sessions"
                  children={false}
                />
              </SettingsRow>

              <div class="workspace-memory-compose">
                <FormField
                  label="New note"
                  hint={`Plain text, up to ${String(MEMORY_ENTRY_MAX_CHARS)} characters. Stored encrypted on this device.`}
                  error={draftError()}
                >
                  <Textarea
                    name="memory-note"
                    rows={3}
                    maxLength={MEMORY_ENTRY_MAX_CHARS}
                    value={draft()}
                    placeholder="For example: this project uses bun, never npm."
                    disabled={busy()}
                    aria-invalid={draftError() ? true : undefined}
                    onInput={(event) => setDraft(event.currentTarget.value)}
                    onBlur={() => setDraftTouched(draft().length > 0)}
                  />
                </FormField>
                <div class="workspace-memory-actions">
                  <Button type="button" disabled={busy()} onClick={addNote}>
                    Add note
                  </Button>
                </div>
              </div>

              <Show when={notice()}>
                <p class="conventional-settings-note" role="alert">
                  {notice()}
                </p>
              </Show>
              <Show when={view().unreadable > 0}>
                <p class="conventional-settings-note" role="status">
                  {`${String(view().unreadable)} memory ${view().unreadable === 1 ? 'note' : 'notes'} could not be read on this device and ${view().unreadable === 1 ? 'is' : 'are'} not used.`}
                </p>
              </Show>

              <Show when={view().pending.length > 0}>
                <ItemGroup label="Proposed by agents" listLabel="Pending memory proposals">
                  <For each={view().pending}>
                    {(entry) => (
                      <ItemGroupEntry
                        variant="outline"
                        trailing={
                          <>
                            <Button
                              type="button"
                              size="sm"
                              disabled={busy()}
                              aria-label={`Accept proposal from ${memoryDateLabel(entry.createdAt)}`}
                              onClick={() =>
                                void mutate(() => props.service.acceptProposal(entryRef(entry)))
                              }
                            >
                              Accept
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={busy()}
                              aria-label={`Reject proposal from ${memoryDateLabel(entry.createdAt)}`}
                              onClick={() =>
                                void mutate(() => props.service.rejectProposal(entryRef(entry)))
                              }
                            >
                              Reject
                            </Button>
                          </>
                        }
                      >
                        <p class="workspace-memory-text">{entry.text}</p>
                        <EntryMeta entry={entry} pending />
                      </ItemGroupEntry>
                    )}
                  </For>
                </ItemGroup>
              </Show>

              <Show
                when={view().active.length > 0}
                fallback={
                  <Empty>
                    <EmptyHeader>
                      <EmptyTitle>No memory yet</EmptyTitle>
                      <EmptyDescription>
                        Notes you add here are given to agents when they start working in this
                        workspace.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                }
              >
                <ItemGroup label="Memory" listLabel="Workspace memory notes">
                  <For each={view().active}>
                    {(entry) => (
                      <ItemGroupEntry
                        variant="outline"
                        trailing={
                          <Show when={editing()?.id !== entry.id}>
                            <ActionButton
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label="Edit note"
                              tooltip="Edit note"
                              disabled={busy()}
                              onClick={() => setEditing({ id: entry.id, text: entry.text })}
                            >
                              <Pencil aria-hidden="true" />
                            </ActionButton>
                            <ActionButton
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label="Delete note"
                              tooltip="Delete note"
                              disabled={busy()}
                              onClick={() =>
                                void mutate(() => props.service.remove(entryRef(entry)))
                              }
                            >
                              <Trash2 aria-hidden="true" />
                            </ActionButton>
                          </Show>
                        }
                      >
                        <Show
                          when={editing()?.id === entry.id ? editing() : undefined}
                          fallback={<p class="workspace-memory-text">{entry.text}</p>}
                        >
                          {(current) => (
                            <div class="workspace-memory-compose">
                              <FormField label="Edit note" error={memoryDraftError(current().text)}>
                                <Textarea
                                  name="memory-note-edit"
                                  rows={3}
                                  maxLength={MEMORY_ENTRY_MAX_CHARS}
                                  value={current().text}
                                  disabled={busy()}
                                  aria-invalid={memoryDraftError(current().text) ? true : undefined}
                                  onInput={(event) =>
                                    setEditing({ id: entry.id, text: event.currentTarget.value })
                                  }
                                />
                              </FormField>
                              <div class="workspace-memory-actions">
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  disabled={busy()}
                                  onClick={() => setEditing(null)}
                                >
                                  Cancel
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  disabled={busy() || Boolean(memoryDraftError(current().text))}
                                  onClick={() => saveEdit(entry)}
                                >
                                  Save
                                </Button>
                              </div>
                            </div>
                          )}
                        </Show>
                        <EntryMeta entry={entry} />
                      </ItemGroupEntry>
                    )}
                  </For>
                </ItemGroup>
              </Show>
            </>
          )}
        </Show>
      </div>
    </Show>
  )
}

function EntryMeta(props: { entry: WorkspaceMemoryEntry; pending?: boolean }) {
  return (
    <div class="workspace-memory-meta">
      <Badge variant={props.entry.source === 'agent' ? 'info' : 'secondary'} size="sm">
        {memorySourceLabel(props.entry)}
      </Badge>
      <Show when={props.pending}>
        <Badge variant="warning" size="sm">
          Pending
        </Badge>
      </Show>
      <span>{memoryDateLabel(props.entry.updatedAt)}</span>
    </div>
  )
}

export default MemoryPane
