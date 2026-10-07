// Workspace settings › Skills (ADR 0013). Lazy: loaded only when the section
// opens. Lists the Skills and agent profiles this workspace sees in the
// Control Plane catalog — its own and read-only system items — and lets
// owners and admins publish a skill and deprecate or revoke workspace items.
// Without an API client (a host with no Adea session) the pane renders its
// typed unavailable state instead of dead controls.
import type { AgentHqApiClient, ApiCatalogItem, ApiCatalogListResponse } from '@adea-ai/api-client'
import { settledData } from '@adea-ai/data'
import {
  useCatalogLifecycleMutation,
  usePublishSkillMutation,
  useWorkspaceAgentProfilesQuery,
  useWorkspaceSkillsQuery,
} from '@adea-ai/data/control-plane'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
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
import { Label } from '@adea-ai/ui/components/ui/label'
import { Textarea } from '@adea-ai/ui/components/ui/textarea'
import { RefreshCw } from 'lucide-solid'
import { For, Show, createSignal } from 'solid-js'

import {
  canRetire,
  catalogItemDetail,
  controlPlaneActionNotice,
  controlPlaneLoadNotice,
  lifecycleLabel,
  lifecycleTone,
  parseSkillDraft,
} from './control-plane-settings-model'

type Notice = Readonly<{ tone: 'alert' | 'status'; text: string }>

const MANIFEST_PLACEHOLDER = `{
  "schemaVersion": 1,
  "semanticVersion": "1.0.0",
  "requiredCapabilities": [],
  "requiredTools": [],
  "dependencies": [],
  "conflicts": [],
  "supersedes": [],
  "compatibleProfileSchemaVersions": [1],
  "compatibleContractMajorVersions": [3]
}`
const CONTENT_PLACEHOLDER = `{
  "instructions": "Summarize merged changes.",
  "artifactRefs": []
}`

export default function SkillsPane(props: { client?: AgentHqApiClient; workspaceId: string }) {
  return (
    <Show
      when={props.client}
      fallback={
        <EmptyDescription role="status">Skills are unavailable in this view.</EmptyDescription>
      }
    >
      {(client) => <SkillsContent client={client()} workspaceId={props.workspaceId} />}
    </Show>
  )
}

function SkillsContent(props: { client: AgentHqApiClient; workspaceId: string }) {
  const workspaceId = () => props.workspaceId
  const skills = useWorkspaceSkillsQuery(props.client, workspaceId)
  const profiles = useWorkspaceAgentProfilesQuery(props.client, workspaceId)
  const lifecycle = useCatalogLifecycleMutation(props.client, workspaceId)
  const publish = usePublishSkillMutation(props.client, workspaceId)
  const [notice, setNotice] = createSignal<Notice>()
  const [publishing, setPublishing] = createSignal(false)
  const [draftName, setDraftName] = createSignal('')
  const [draftManifest, setDraftManifest] = createSignal('')
  const [draftContent, setDraftContent] = createSignal('')

  const canManage = () => Boolean(settledData(skills)?.canManage)

  const retire = (item: ApiCatalogItem, action: 'deprecate' | 'revoke', reason: string) => {
    setNotice(undefined)
    const verb = action === 'deprecate' ? 'Deprecating' : 'Revoking'
    lifecycle.mutate(
      { action, id: item.id, input: { reason }, kind: item.kind },
      {
        onError: (error) =>
          setNotice({
            tone: 'alert',
            text: controlPlaneActionNotice(`${verb} ${item.displayName}`, error),
          }),
        onSuccess: () =>
          setNotice({
            tone: 'status',
            text: `${item.displayName} ${action === 'deprecate' ? 'deprecated' : 'revoked'}.`,
          }),
      }
    )
  }

  const submitSkill = () => {
    const parsed = parseSkillDraft({
      content: draftContent(),
      displayName: draftName(),
      manifest: draftManifest(),
    })
    if (!parsed.ok) {
      setNotice({ tone: 'alert', text: parsed.problem })
      return
    }
    setNotice(undefined)
    publish.mutate(parsed.value, {
      onError: (error) =>
        setNotice({ tone: 'alert', text: controlPlaneActionNotice('Publishing the skill', error) }),
      onSuccess: (result) => {
        setNotice({
          tone: 'status',
          text: `${result.item.displayName} ${result.version.version} published.`,
        })
        setPublishing(false)
        setDraftName('')
        setDraftManifest('')
        setDraftContent('')
      },
    })
  }

  const refresh = () => {
    setNotice(undefined)
    void skills.refetch()
    void profiles.refetch()
  }

  return (
    <>
      <SettingsSection
        title="Skills"
        description="Instructions agents can use in this workspace's cloud runs. System skills are shared and read-only."
        action={
          <>
            <ActionButton
              type="button"
              variant="ghost"
              size="icon-sm"
              tooltip="Reload skills and agent profiles from the Control Plane"
              aria-label="Reload skills"
              disabled={skills.isFetching || profiles.isFetching}
              onClick={refresh}
            >
              <RefreshCw aria-hidden="true" />
            </ActionButton>
            <Show when={canManage() && !publishing()}>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setNotice(undefined)
                  setPublishing(true)
                }}
              >
                Publish a skill…
              </Button>
            </Show>
          </>
        }
      >
        <CatalogList
          busy={lifecycle.isPending}
          canManage={canManage()}
          emptyText="No skills are visible to this workspace yet."
          error={skills.error}
          loading={skills.isPending}
          onRetire={retire}
          page={settledData(skills)}
          subject="Skills"
        />
      </SettingsSection>
      <Show when={canManage() && publishing()}>
        <form
          aria-label="Publish a skill"
          onSubmit={(event) => {
            event.preventDefault()
            submitSkill()
          }}
        >
          <SettingsSection
            title="Publish a skill"
            description="Each publish creates a new immutable skill. Never paste secrets: the Control Plane rejects skills that contain credentials."
          >
            <SettingsField label="Name" htmlFor="skills-publish-name">
              <Input
                id="skills-publish-name"
                maxLength={128}
                placeholder="Release notes"
                value={draftName()}
                onInput={(event) => setDraftName(event.currentTarget.value)}
              />
            </SettingsField>
            <SettingsField
              label="Manifest (JSON)"
              description="Needs a semanticVersion; the Control Plane validates the rest."
              htmlFor="skills-publish-manifest"
            >
              <Textarea
                id="skills-publish-manifest"
                rows={8}
                class="field-sizing-fixed"
                spellcheck={false}
                placeholder={MANIFEST_PLACEHOLDER}
                value={draftManifest()}
                onInput={(event) => setDraftManifest(event.currentTarget.value)}
              />
            </SettingsField>
            <SettingsField
              label="Content (JSON)"
              description="Needs instructions text."
              htmlFor="skills-publish-content"
            >
              <Textarea
                id="skills-publish-content"
                rows={5}
                class="field-sizing-fixed"
                spellcheck={false}
                placeholder={CONTENT_PLACEHOLDER}
                value={draftContent()}
                onInput={(event) => setDraftContent(event.currentTarget.value)}
              />
            </SettingsField>
            <div class="flex items-center gap-2 p-4">
              <Button type="submit" disabled={publish.isPending}>
                {publish.isPending ? 'Publishing…' : 'Publish'}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setPublishing(false)}>
                Cancel
              </Button>
            </div>
          </SettingsSection>
        </form>
      </Show>
      <SettingsSection
        title="Agent profiles"
        description="Profiles cloud agents run with. Publish profiles from the Control Plane; manage this workspace's here."
      >
        <CatalogList
          busy={lifecycle.isPending}
          canManage={Boolean(settledData(profiles)?.canManage)}
          emptyText="No agent profiles are visible to this workspace yet."
          error={profiles.error}
          loading={profiles.isPending}
          onRetire={retire}
          page={settledData(profiles)}
          subject="Agent profiles"
        />
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
  )
}

function CatalogList(props: {
  busy: boolean
  canManage: boolean
  emptyText: string
  error: unknown
  loading: boolean
  onRetire: (item: ApiCatalogItem, action: 'deprecate' | 'revoke', reason: string) => void
  page: ApiCatalogListResponse | undefined
  subject: string
}) {
  return (
    <Show
      when={props.page}
      fallback={
        <EmptyDescription role="status">
          {props.loading
            ? `Loading ${props.subject.toLowerCase()}…`
            : controlPlaneLoadNotice(props.subject, props.error)}
        </EmptyDescription>
      }
    >
      {(page) => (
        <Show
          when={page().items.length > 0}
          fallback={<EmptyDescription role="status">{props.emptyText}</EmptyDescription>}
        >
          <For each={page().items}>
            {(item) => (
              <SettingsRow label={item.displayName} description={catalogItemDetail(item)}>
                <div class="flex flex-wrap items-center justify-end gap-2">
                  <Badge variant={lifecycleTone(item)}>{lifecycleLabel(item)}</Badge>
                  <Show when={item.readOnly}>
                    <Badge variant="outline">Read-only</Badge>
                  </Show>
                  <Show when={props.canManage && canRetire(item, 'deprecate')}>
                    <RetireAction
                      action="deprecate"
                      busy={props.busy}
                      item={item}
                      onConfirm={props.onRetire}
                    />
                  </Show>
                  <Show when={props.canManage && canRetire(item, 'revoke')}>
                    <RetireAction
                      action="revoke"
                      busy={props.busy}
                      item={item}
                      onConfirm={props.onRetire}
                    />
                  </Show>
                </div>
              </SettingsRow>
            )}
          </For>
          <Show when={page().nextCursor}>
            <EmptyDescription>
              Showing the first {page().items.length}. Older items stay available in the Control
              Plane.
            </EmptyDescription>
          </Show>
        </Show>
      )}
    </Show>
  )
}

function RetireAction(props: {
  action: 'deprecate' | 'revoke'
  busy: boolean
  item: ApiCatalogItem
  onConfirm: (item: ApiCatalogItem, action: 'deprecate' | 'revoke', reason: string) => void
}) {
  const deprecate = () => props.action === 'deprecate'
  const [reason, setReason] = createSignal('No longer used in this workspace')
  const reasonId = () => `skills-${props.action}-reason-${props.item.id}`
  return (
    <AlertDialog>
      <AlertDialogTrigger
        as={Button}
        type="button"
        variant={deprecate() ? 'outline' : 'ghost'}
        size="sm"
        aria-label={`${deprecate() ? 'Deprecate' : 'Revoke'} ${props.item.displayName}`}
        disabled={props.busy}
      >
        {deprecate() ? 'Deprecate' : 'Revoke'}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {deprecate() ? 'Deprecate' : 'Revoke'} {props.item.displayName}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {deprecate()
              ? 'Every published version is marked deprecated. Agents that already use it keep working, but it should not be chosen for new work.'
              : 'Every version is revoked and can no longer be resolved by any agent in this workspace. This cannot be undone.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div class="flex flex-col gap-2">
          <Label for={reasonId()}>Reason</Label>
          {/* Explicitly named: the dialog renders inside the item's settings
              row, whose field context would otherwise name this input. */}
          <Input
            id={reasonId()}
            aria-label="Reason"
            maxLength={512}
            value={reason()}
            onInput={(event) => setReason(event.currentTarget.value)}
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel as={Button} type="button" variant="outline">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            as={Button}
            type="button"
            variant="destructive"
            disabled={!reason().trim()}
            onClick={() => props.onConfirm(props.item, props.action, reason().trim())}
          >
            {deprecate() ? 'Deprecate' : 'Revoke'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
