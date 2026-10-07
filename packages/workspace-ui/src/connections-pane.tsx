// Workspace settings › Connections (ADR 0012). Lazy: loaded only when the
// section opens. Reads and writes go through the injected desktop service
// (the authenticated Dev Runtime command path); ids and labels only — no
// secret ever enters this view. Without the service (web-only) the pane
// renders the typed unavailable state instead of dead controls.
import { SettingsRow, SettingsSection } from '@adea-ai/ui/components/composites/settings'
import { Button } from '@adea-ai/ui/components/ui/button'
import { EmptyDescription } from '@adea-ai/ui/components/ui/empty'
import { Input } from '@adea-ai/ui/components/ui/input'
import { NativeSelect } from '@adea-ai/ui/components/ui/native-select'
import { For, Show, createSignal, onMount } from 'solid-js'

import {
  CONNECTIONS_UNAVAILABLE_TEXT,
  DEVICE_DEFAULT_VALUE,
  connectionsNotice,
  gitHostingRows,
  harnessAccountRows,
  isConnectionsUnavailable,
  type HarnessAccountRow,
} from './connections-model'
import type { WorkspaceConnectionsService, WorkspaceConnectionsSnapshot } from './platform'

type PaneState =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'ready'; snapshot: WorkspaceConnectionsSnapshot }>
  | Readonly<{ kind: 'unavailable'; text: string }>

type Notice = Readonly<{ tone: 'status' | 'alert'; text: string }>

export function ConnectionsPane(props: { service?: WorkspaceConnectionsService }) {
  const [state, setState] = createSignal<PaneState>(
    props.service
      ? { kind: 'loading' }
      : { kind: 'unavailable', text: CONNECTIONS_UNAVAILABLE_TEXT }
  )
  const [notice, setNotice] = createSignal<Notice>()
  const [busy, setBusy] = createSignal(false)
  const [addingFor, setAddingFor] = createSignal<string>()
  const [draftLabel, setDraftLabel] = createSignal('')
  const [draftCredential, setDraftCredential] = createSignal('')

  const load = async (): Promise<void> => {
    const service = props.service
    if (!service) return
    try {
      setState({ kind: 'ready', snapshot: await service.load() })
    } catch (error) {
      setState({
        kind: 'unavailable',
        text: isConnectionsUnavailable(error)
          ? CONNECTIONS_UNAVAILABLE_TEXT
          : connectionsNotice('Loading connections', error),
      })
    }
  }
  onMount(() => void load())

  const version = () => {
    const current = state()
    return current.kind === 'ready' ? current.snapshot.connections.version : 0
  }

  const mutate = async (action: string, run: () => Promise<unknown>, done: string) => {
    if (busy()) return
    setBusy(true)
    setNotice(undefined)
    try {
      await run()
      setNotice({ tone: 'status', text: done })
    } catch (error) {
      setNotice({ tone: 'alert', text: connectionsNotice(action, error) })
    } finally {
      // Always re-read the authoritative state; never keep a guessed outcome.
      await load()
      setBusy(false)
    }
  }

  const bindGitHosting = (host: string, value: string) =>
    void mutate(
      'Changing the git hosting connection',
      () =>
        props.service!.setGitHosting({
          host,
          credentialRefId: value === DEVICE_DEFAULT_VALUE ? null : value,
          expectedVersion: version(),
        }),
      value === DEVICE_DEFAULT_VALUE
        ? `${host} now uses the device default.`
        : `${host} now uses the selected credential in this workspace.`
    )

  const bindAccount = (row: HarnessAccountRow, value: string) =>
    void mutate(
      'Changing the harness account',
      () =>
        props.service!.setHarnessAccount({
          harnessId: row.harnessId,
          profileId: value === DEVICE_DEFAULT_VALUE ? null : value,
          expectedVersion: version(),
        }),
      value === DEVICE_DEFAULT_VALUE
        ? `${row.displayName} now uses the device default.`
        : `${row.displayName} now uses the selected account in this workspace.`
    )

  const openAdd = (row: HarnessAccountRow) => {
    setAddingFor(row.harnessId)
    setDraftLabel('')
    setDraftCredential(row.accountCredentials[0]?.value ?? '')
    setNotice(undefined)
  }

  const saveAccount = (row: HarnessAccountRow) => {
    const label = draftLabel().trim()
    const credentialRefId = draftCredential()
    if (label.length === 0 || credentialRefId === '') {
      setNotice({ tone: 'alert', text: 'Name the account and choose its credential first.' })
      return
    }
    void mutate(
      'Adding the account',
      async () => {
        const profile = await props.service!.createAccountProfile({
          harnessId: row.harnessId,
          label,
          credentialRefId,
        })
        await props.service!.setHarnessAccount({
          harnessId: row.harnessId,
          profileId: profile.id,
          expectedVersion: version(),
        })
        setAddingFor(undefined)
      },
      `${label} added and selected for ${row.displayName} in this workspace.`
    )
  }

  return (
    <Show
      when={
        state().kind === 'ready'
          ? (state() as { snapshot: WorkspaceConnectionsSnapshot })
          : undefined
      }
      fallback={
        <EmptyDescription role="status">
          {state().kind === 'loading' ? 'Loading connections…' : (state() as { text: string }).text}
        </EmptyDescription>
      }
    >
      {(ready) => (
        <>
          <SettingsSection
            title="Git hosting"
            description="The credential clone, fetch, push, and pull requests use for each host in this workspace."
          >
            <For each={gitHostingRows(ready().snapshot)}>
              {(row) => (
                <SettingsRow label={row.host} description={row.detail}>
                  <NativeSelect
                    aria-label={`Credential for ${row.host}`}
                    value={row.value}
                    disabled={busy()}
                    options={row.options}
                    onChange={(event) => bindGitHosting(row.host, event.currentTarget.value)}
                  />
                </SettingsRow>
              )}
            </For>
          </SettingsSection>
          <SettingsSection
            title="Harness accounts"
            description="The account or API key each harness uses when it launches in this workspace."
          >
            <Show
              when={harnessAccountRows(ready().snapshot).length > 0}
              fallback={
                <EmptyDescription role="status">
                  No harness is installed on this device yet.
                </EmptyDescription>
              }
            >
              <For each={harnessAccountRows(ready().snapshot)}>
                {(row) => (
                  <>
                    <SettingsRow label={row.displayName} description={row.detail}>
                      {/* The shared row control slot shrink-wraps its children;
                         spacing the pair here keeps the select and the add
                         action from touching. */}
                      <div class="flex flex-wrap items-center gap-2">
                        <NativeSelect
                          aria-label={`Account for ${row.displayName}`}
                          value={row.value}
                          disabled={busy()}
                          options={row.options}
                          onChange={(event) => bindAccount(row, event.currentTarget.value)}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          disabled={busy()}
                          onClick={() => openAdd(row)}
                        >
                          Add account…
                        </Button>
                      </div>
                    </SettingsRow>
                    <Show when={addingFor() === row.harnessId}>
                      <SettingsRow
                        orientation="vertical"
                        label={`New ${row.displayName} account`}
                        description={
                          row.accountCredentials.length > 0
                            ? 'Name the account and choose the vaulted API key it uses.'
                            : `No ready API key for ${row.displayName} is in this device’s vault yet.`
                        }
                      >
                        <Input
                          aria-label="Account name"
                          maxLength={80}
                          value={draftLabel()}
                          placeholder="Work account"
                          onInput={(event) => setDraftLabel(event.currentTarget.value)}
                        />
                        <NativeSelect
                          aria-label="Account credential"
                          value={draftCredential()}
                          options={row.accountCredentials}
                          onChange={(event) => setDraftCredential(event.currentTarget.value)}
                        />
                        <Button
                          type="button"
                          disabled={busy() || row.accountCredentials.length === 0}
                          onClick={() => saveAccount(row)}
                        >
                          Save account
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => setAddingFor(undefined)}
                        >
                          Cancel
                        </Button>
                      </SettingsRow>
                    </Show>
                  </>
                )}
              </For>
            </Show>
          </SettingsSection>
          <Show when={notice()}>
            {(current) => (
              <p
                class="conventional-settings-note"
                role={current().tone === 'alert' ? 'alert' : 'status'}
              >
                {current().text}
              </p>
            )}
          </Show>
        </>
      )}
    </Show>
  )
}
