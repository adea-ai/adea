// Workspace settings › Connections › Cloud (ADR 0013). Lazy: loaded only
// when the Connections section opens. Cloud connections are connector
// credentials held in the Control Plane vault for cloud executions; local
// runs keep using the device bindings above. The secret is write-only: it
// lives in a password field until it is sent once, is cleared on every
// outcome, and no list or response ever carries it back.
import type {
  AgentHqApiClient,
  ApiCloudConnection,
  ApiCloudConnectionsResponse,
} from '@adea-ai/api-client'
import { settledData } from '@adea-ai/data'
import {
  useCloudConnectionsQuery,
  useCreateCloudConnectionMutation,
  useRevokeCloudConnectionMutation,
  useRotateCloudConnectionMutation,
} from '@adea-ai/data/control-plane'
import {
  SettingsField,
  SettingsRow,
  SettingsSection,
} from '@adea-ai/ui/components/composites/settings'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@adea-ai/ui/components/ui/alert-dialog'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { Button } from '@adea-ai/ui/components/ui/button'
import { EmptyDescription } from '@adea-ai/ui/components/ui/empty'
import { Input } from '@adea-ai/ui/components/ui/input'
import { For, Show, createSignal } from 'solid-js'

import {
  canChangeConnection,
  cloudConnectionDraftProblem,
  connectionDetail,
  connectionStatusLabel,
  connectionStatusTone,
  controlPlaneActionNotice,
  controlPlaneLoadNotice,
  defaultConnectorRef,
  secretProblem,
} from './control-plane-settings-model'

type Notice = Readonly<{ tone: 'alert' | 'status'; text: string }>

const CLOUD_TITLE = 'Cloud'
const CLOUD_DESCRIPTION =
  'Connector credentials cloud agents use in this workspace, kept in the Control Plane vault. A secret is sent once and never shown again.'

export default function CloudConnectionsPane(props: {
  client?: AgentHqApiClient
  workspaceId: string
}) {
  return (
    <Show
      when={props.client}
      fallback={
        <SettingsSection title={CLOUD_TITLE} description={CLOUD_DESCRIPTION}>
          <EmptyDescription role="status">
            Cloud connections are unavailable in this view.
          </EmptyDescription>
        </SettingsSection>
      }
    >
      {(client) => <CloudConnectionsContent client={client()} workspaceId={props.workspaceId} />}
    </Show>
  )
}

function CloudConnectionsContent(props: { client: AgentHqApiClient; workspaceId: string }) {
  const workspaceId = () => props.workspaceId
  const connections = useCloudConnectionsQuery(props.client, workspaceId)
  const create = useCreateCloudConnectionMutation(props.client, workspaceId)
  const rotate = useRotateCloudConnectionMutation(props.client, workspaceId)
  const revoke = useRevokeCloudConnectionMutation(props.client, workspaceId)
  const [notice, setNotice] = createSignal<Notice>()
  const [adding, setAdding] = createSignal(false)
  const [provider, setProvider] = createSignal('')
  const [connectorRef, setConnectorRef] = createSignal('')
  const [secret, setSecret] = createSignal('')

  const page = (): ApiCloudConnectionsResponse | undefined => settledData(connections)
  const canManage = () => Boolean(page()?.canManage)
  const busy = () => create.isPending || rotate.isPending || revoke.isPending

  const closeAdd = () => {
    setAdding(false)
    setProvider('')
    setConnectorRef('')
    setSecret('')
  }

  const submitAdd = () => {
    const draft = { connectorRef: connectorRef(), provider: provider(), secret: secret() }
    const problem = cloudConnectionDraftProblem(draft)
    if (problem) {
      setNotice({ tone: 'alert', text: problem })
      return
    }
    const name = draft.provider.trim()
    setNotice(undefined)
    create.mutate(
      {
        connectorRef: draft.connectorRef.trim() || defaultConnectorRef(name),
        provider: name,
        secret: draft.secret,
      },
      {
        onError: (error) =>
          setNotice({
            tone: 'alert',
            text: controlPlaneActionNotice('Adding the cloud connection', error),
          }),
        onSuccess: () => {
          setNotice({ tone: 'status', text: `${name} cloud connection added.` })
          closeAdd()
        },
        onSettled: () => {
          // The secret never outlives the request, whatever the outcome.
          setSecret('')
          create.reset()
        },
      }
    )
  }

  const submitRotate = (connection: ApiCloudConnection, value: string, done: () => void) => {
    const problem = secretProblem(value)
    if (problem) {
      setNotice({ tone: 'alert', text: problem })
      return
    }
    setNotice(undefined)
    rotate.mutate(
      {
        credentialId: connection.credentialId,
        input: { expectedRevision: connection.revision, secret: value },
      },
      {
        onError: (error) =>
          setNotice({
            tone: 'alert',
            text: controlPlaneActionNotice(`Rotating ${connection.provider}`, error),
          }),
        onSuccess: () =>
          setNotice({ tone: 'status', text: `${connection.provider} secret rotated.` }),
        onSettled: () => {
          done()
          rotate.reset()
        },
      }
    )
  }

  const submitRevoke = (connection: ApiCloudConnection) => {
    setNotice(undefined)
    revoke.mutate(
      { credentialId: connection.credentialId },
      {
        onError: (error) =>
          setNotice({
            tone: 'alert',
            text: controlPlaneActionNotice(`Revoking ${connection.provider}`, error),
          }),
        onSuccess: () =>
          setNotice({ tone: 'status', text: `${connection.provider} cloud connection revoked.` }),
      }
    )
  }

  return (
    <>
      <SettingsSection
        title={CLOUD_TITLE}
        description={CLOUD_DESCRIPTION}
        action={
          <Show when={canManage() && !adding()}>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setNotice(undefined)
                setAdding(true)
              }}
            >
              Add cloud connection…
            </Button>
          </Show>
        }
      >
        <Show
          when={page()}
          fallback={
            <EmptyDescription role="status">
              {connections.isPending
                ? 'Loading cloud connections…'
                : controlPlaneLoadNotice('Cloud connections', connections.error)}
            </EmptyDescription>
          }
        >
          {(current) => (
            <Show
              when={current().connections.length > 0}
              fallback={
                <EmptyDescription role="status">
                  No cloud connections yet. Cloud agents run without connector credentials.
                </EmptyDescription>
              }
            >
              <For each={current().connections}>
                {(connection) => (
                  <ConnectionRow
                    busy={busy()}
                    canManage={canManage()}
                    connection={connection}
                    onRevoke={submitRevoke}
                    onRotate={submitRotate}
                  />
                )}
              </For>
            </Show>
          )}
        </Show>
      </SettingsSection>
      <Show when={canManage() && adding()}>
        <form
          aria-label="Add a cloud connection"
          autocomplete="off"
          onSubmit={(event) => {
            event.preventDefault()
            submitAdd()
          }}
        >
          <SettingsSection
            title="Add a cloud connection"
            description="The secret goes to the vault once. Adea keeps only the connection's id, provider and status."
          >
            <SettingsField label="Provider" htmlFor="cloud-connection-provider">
              <Input
                id="cloud-connection-provider"
                maxLength={128}
                placeholder="github"
                autocomplete="off"
                value={provider()}
                onInput={(event) => setProvider(event.currentTarget.value)}
              />
            </SettingsField>
            <SettingsField
              label="Connector reference"
              description="Defaults to connector:<provider>."
              htmlFor="cloud-connection-connector"
            >
              <Input
                id="cloud-connection-connector"
                maxLength={256}
                placeholder={defaultConnectorRef(provider().trim() || 'github')}
                autocomplete="off"
                value={connectorRef()}
                onInput={(event) => setConnectorRef(event.currentTarget.value)}
              />
            </SettingsField>
            <SettingsField label="Secret" htmlFor="cloud-connection-secret">
              <Input
                id="cloud-connection-secret"
                type="password"
                autocomplete="new-password"
                spellcheck={false}
                maxLength={65_536}
                value={secret()}
                onInput={(event) => setSecret(event.currentTarget.value)}
              />
            </SettingsField>
            <div class="flex items-center gap-2 p-4">
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? 'Adding…' : 'Add connection'}
              </Button>
              <Button type="button" variant="ghost" onClick={closeAdd}>
                Cancel
              </Button>
            </div>
          </SettingsSection>
        </form>
      </Show>
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
  )
}

function ConnectionRow(props: {
  busy: boolean
  canManage: boolean
  connection: ApiCloudConnection
  onRevoke: (connection: ApiCloudConnection) => void
  onRotate: (connection: ApiCloudConnection, secret: string, done: () => void) => void
}) {
  const [rotating, setRotating] = createSignal(false)
  const [secret, setSecret] = createSignal('')
  const finishRotate = () => {
    setSecret('')
    setRotating(false)
  }
  return (
    <>
      <SettingsRow
        label={props.connection.provider}
        description={connectionDetail(props.connection)}
      >
        <div class="flex flex-wrap items-center justify-end gap-2">
          <Badge variant={connectionStatusTone(props.connection)}>
            {connectionStatusLabel(props.connection)}
          </Badge>
          <Show when={props.canManage && canChangeConnection(props.connection)}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={`Rotate the ${props.connection.provider} secret`}
              disabled={props.busy}
              onClick={() => setRotating(true)}
            >
              Rotate
            </Button>
            <AlertDialog>
              <AlertDialogTrigger
                as={Button}
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Revoke the ${props.connection.provider} cloud connection`}
                disabled={props.busy}
              >
                Revoke
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Revoke the {props.connection.provider} connection?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    The vault revokes every secret revision and outstanding lease at once. Cloud
                    agents in this workspace lose access to {props.connection.connectorRef}. This
                    cannot be undone; add a new connection to restore access.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel as={Button} type="button" variant="outline">
                    Keep connection
                  </AlertDialogCancel>
                  <AlertDialogAction
                    as={Button}
                    type="button"
                    variant="destructive"
                    onClick={() => props.onRevoke(props.connection)}
                  >
                    Revoke
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </Show>
        </div>
      </SettingsRow>
      <Show when={rotating()}>
        <form
          aria-label={`Rotate the ${props.connection.provider} secret`}
          autocomplete="off"
          onSubmit={(event) => {
            event.preventDefault()
            props.onRotate(props.connection, secret(), finishRotate)
          }}
        >
          <SettingsRow
            orientation="vertical"
            label={`New ${props.connection.provider} secret`}
            description="Stores the new secret as the next revision of this connection."
          >
            <div class="flex items-center gap-2">
              <Input
                class="min-w-0 flex-1"
                type="password"
                autocomplete="new-password"
                spellcheck={false}
                maxLength={65_536}
                value={secret()}
                onInput={(event) => setSecret(event.currentTarget.value)}
              />
              <Button type="submit" disabled={props.busy}>
                Rotate secret
              </Button>
              <Button type="button" variant="ghost" onClick={finishRotate}>
                Cancel
              </Button>
            </div>
          </SettingsRow>
        </form>
      </Show>
    </>
  )
}
