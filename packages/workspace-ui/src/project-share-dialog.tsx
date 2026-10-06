import type { AgentHqApiClient } from '@adea-ai/api-client'
import {
  settledData,
  useCreateWorkspaceInvitationMutation,
  useProjectMembersQuery,
  useRemoveProjectMemberMutation,
  useRevokeWorkspaceInvitationMutation,
  useSetProjectMemberMutation,
  useSetProjectVisibilityMutation,
  useWorkspaceInvitationsQuery,
  useWorkspaceMembersQuery,
} from '@adea-ai/data'
import type {
  ProjectMemberRole,
  ProjectSummary,
  ProjectVisibility,
  WorkspaceInvitationRole,
  WorkspaceInvitationSummary,
} from '@adea-ai/types'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
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
import { Button } from '@adea-ai/ui/components/ui/button'
import { ValueCombobox } from '@adea-ai/ui/components/ui/combobox'
import { Input } from '@adea-ai/ui/components/ui/input'
import { Label } from '@adea-ai/ui/components/ui/label'
import { ModalDialog } from '@adea-ai/ui/components/ui/modal-dialog'
import { NativeSelect } from '@adea-ai/ui/components/ui/native-select'
import { RadioGroup, RadioGroupItem } from '@adea-ai/ui/components/ui/radio-group'
import { X } from 'lucide-solid'
import { createMemo, createSignal, For, Show } from 'solid-js'

import {
  canManageSharing,
  invitationDetail,
  memberLabel,
  pendingInvitations,
  shareCandidates,
} from './project-share-model'

const PROJECT_ROLE_OPTIONS = [
  { label: 'Can edit', value: 'editor' },
  { label: 'Can view', value: 'viewer' },
] as const

const INVITATION_ROLE_OPTIONS = [
  { label: 'Member', value: 'member' },
  { label: 'Admin', value: 'admin' },
] as const

export type ProjectShareDialogProps = Readonly<{
  client: AgentHqApiClient
  /** The signed-in user, to decide whether they may change sharing. */
  currentUserId?: string
  onClose: () => void
  open: boolean
  project: ProjectSummary
  workspaceId: string
}>

/**
 * Share a project (ADR 0012): who can see it, who is on it with which role,
 * and invitations into the workspace. Workspace owners and admins change
 * sharing; everyone else who can see the project gets a read-only view.
 * Invitations produce a copyable link — no email is sent — and stay listed as
 * pending until accepted, so an owner or admin can revoke one before it is used.
 */
export function ProjectShareDialog(props: ProjectShareDialogProps) {
  const workspaceId = () => props.workspaceId
  const projectId = () => props.project.id
  const workspaceMembers = useWorkspaceMembersQuery(props.client, workspaceId)
  const projectMembers = useProjectMembersQuery(props.client, workspaceId, projectId)
  const setVisibility = useSetProjectVisibilityMutation(props.client, workspaceId, projectId)
  const setMember = useSetProjectMemberMutation(props.client, workspaceId, projectId)
  const removeMember = useRemoveProjectMemberMutation(props.client, workspaceId, projectId)
  const createInvitation = useCreateWorkspaceInvitationMutation(props.client, workspaceId)
  const revokeInvitation = useRevokeWorkspaceInvitationMutation(props.client, workspaceId)

  const [visibility, setVisibilityValue] = createSignal<ProjectVisibility>(props.project.visibility)
  const [candidate, setCandidate] = createSignal('')
  const [candidateRole, setCandidateRole] = createSignal<ProjectMemberRole>('editor')
  const [inviteEmail, setInviteEmail] = createSignal('')
  const [inviteRole, setInviteRole] = createSignal<WorkspaceInvitationRole>('member')
  const [inviteLink, setInviteLink] = createSignal<string | null>(null)
  const [copied, setCopied] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const members = () => settledData(workspaceMembers)?.members ?? []
  const listed = () => settledData(projectMembers)?.members ?? []
  const canManage = createMemo(() => canManageSharing(members(), props.currentUserId))
  // Only owners and admins may list invitations; the server enforces the same rule.
  const invitations = useWorkspaceInvitationsQuery(props.client, workspaceId, canManage)
  const pending = createMemo(() => pendingInvitations(settledData(invitations)?.invitations ?? []))
  const candidates = createMemo(() => shareCandidates(members(), listed()))

  const run = async (work: () => Promise<unknown>, failure: string) => {
    setError(null)
    try {
      await work()
      return true
    } catch {
      setError(failure)
      return false
    }
  }

  const changeVisibility = (next: ProjectVisibility) => {
    const previous = visibility()
    setVisibilityValue(next)
    void run(
      () => setVisibility.mutateAsync(next),
      'Visibility could not be changed. Try again.'
    ).then((saved) => {
      if (!saved) setVisibilityValue(previous)
    })
  }

  const addCandidate = () => {
    const userId = candidate()
    if (!userId) return
    void run(
      () => setMember.mutateAsync({ role: candidateRole(), userId }),
      'That member could not be added. Try again.'
    ).then((saved) => {
      if (saved) setCandidate('')
    })
  }

  const invite = () => {
    const email = inviteEmail().trim()
    if (!email) return
    setInviteLink(null)
    setCopied(false)
    void run(async () => {
      const created = await createInvitation.mutateAsync({ email, role: inviteRole() })
      setInviteLink(new URL(created.acceptPath, window.location.origin).toString())
      setInviteEmail('')
    }, 'The invitation could not be created. Check the email address and try again.')
  }

  const revoke = (invitation: WorkspaceInvitationSummary) =>
    void run(
      () => revokeInvitation.mutateAsync(invitation.id),
      'The invitation could not be revoked. Try again.'
    )

  const copyLink = () => {
    const link = inviteLink()
    if (!link) return
    void navigator.clipboard
      .writeText(link)
      .then(() => setCopied(true))
      .catch(() => setError('Copy failed. Select the link and copy it manually.'))
  }

  return (
    <ModalDialog
      class="conventional-dialog"
      open={props.open}
      onClose={props.onClose}
      title={`Share ${props.project.name}`}
      description={
        canManage()
          ? 'Choose who can see this project and its conversations, and invite people into the workspace.'
          : 'Who can see this project. Only workspace owners and admins change sharing.'
      }
    >
      <div class="flex flex-col gap-6">
        <section class="flex flex-col gap-3" aria-labelledby="project-share-visibility">
          <h3 id="project-share-visibility" class="text-sm font-medium">
            Who can see this project
          </h3>
          <RadioGroup
            aria-labelledby="project-share-visibility"
            value={visibility()}
            disabled={!canManage() || setVisibility.isPending}
            onChange={(value) => changeVisibility(value === 'members' ? 'members' : 'workspace')}
          >
            <RadioGroupItem value="workspace" label="Everyone in the workspace" />
            <RadioGroupItem value="members" label="Only people you add" />
          </RadioGroup>
          <Show when={visibility() === 'workspace' && listed().length}>
            <p class="text-sm text-muted-foreground">
              Roles below apply once only the people you add can see this project.
            </p>
          </Show>
        </section>

        <section class="flex flex-col gap-3" aria-labelledby="project-share-members">
          <h3 id="project-share-members" class="text-sm font-medium">
            People on this project
          </h3>
          <Show
            when={listed().length}
            fallback={
              <p class="text-sm text-muted-foreground">
                No one has been added yet. Workspace owners and admins always have access.
              </p>
            }
          >
            <ul class="flex flex-col gap-2" aria-label="Project members">
              <For each={listed()}>
                {(member) => (
                  <li class="flex items-center gap-2">
                    <span class="min-w-0 flex-1 truncate text-sm">{memberLabel(member)}</span>
                    <NativeSelect
                      aria-label={`Role for ${memberLabel(member)}`}
                      value={member.role}
                      disabled={!canManage() || setMember.isPending}
                      options={PROJECT_ROLE_OPTIONS}
                      onChange={(event) =>
                        void run(
                          () =>
                            setMember.mutateAsync({
                              role: event.currentTarget.value === 'viewer' ? 'viewer' : 'editor',
                              userId: member.userId,
                            }),
                          'The role could not be changed. Try again.'
                        )
                      }
                    />
                    <Show when={canManage()}>
                      <ActionButton
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        tooltip={`Remove ${memberLabel(member)} from this project`}
                        aria-label={`Remove ${memberLabel(member)}`}
                        disabled={removeMember.isPending}
                        onClick={() =>
                          void run(
                            () => removeMember.mutateAsync(member.userId),
                            'That member could not be removed. Try again.'
                          )
                        }
                      >
                        <X aria-hidden="true" />
                      </ActionButton>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <Show when={canManage() && candidates().length}>
            <div class="flex flex-col gap-2">
              <Label for="project-share-add-member">Add a workspace member</Label>
              <div class="flex items-center gap-2">
                <ValueCombobox
                  id="project-share-add-member"
                  class="min-w-0 flex-1"
                  placeholder="Search members"
                  value={candidate()}
                  choices={candidates()}
                  onValueChange={setCandidate}
                />
                <NativeSelect
                  aria-label="Role for the new member"
                  value={candidateRole()}
                  options={PROJECT_ROLE_OPTIONS}
                  onChange={(event) =>
                    setCandidateRole(event.currentTarget.value === 'viewer' ? 'viewer' : 'editor')
                  }
                />
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!candidate() || setMember.isPending}
                  onClick={addCandidate}
                >
                  Add
                </Button>
              </div>
            </div>
          </Show>
        </section>

        <Show when={canManage()}>
          <section class="flex flex-col gap-3" aria-labelledby="project-share-invite">
            <h3 id="project-share-invite" class="text-sm font-medium">
              Invite someone new to the workspace
            </h3>
            <form
              class="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                invite()
              }}
            >
              <Input
                class="min-w-0 flex-1"
                type="email"
                required
                maxLength={320}
                aria-label="Email address to invite"
                placeholder="name@example.com"
                value={inviteEmail()}
                onInput={(event) => setInviteEmail(event.currentTarget.value)}
              />
              <NativeSelect
                aria-label="Workspace role for the invitation"
                value={inviteRole()}
                options={INVITATION_ROLE_OPTIONS}
                onChange={(event) =>
                  setInviteRole(event.currentTarget.value === 'admin' ? 'admin' : 'member')
                }
              />
              <Button type="submit" disabled={createInvitation.isPending}>
                {createInvitation.isPending ? 'Creating…' : 'Create link'}
              </Button>
            </form>
            <Show when={inviteLink()}>
              {(link) => (
                <div class="flex flex-col gap-2">
                  <Label for="project-share-invite-link">Invitation link</Label>
                  <div class="flex items-center gap-2">
                    <Input
                      id="project-share-invite-link"
                      class="min-w-0 flex-1"
                      readOnly
                      value={link()}
                      onFocus={(event) => event.currentTarget.select()}
                    />
                    <Button type="button" variant="secondary" onClick={copyLink}>
                      {copied() ? 'Copied' : 'Copy link'}
                    </Button>
                  </div>
                  <p class="text-sm text-muted-foreground">
                    This link is shown once. It works for seven days, a single time, for an account
                    signed in with that email address. No email is sent — share it yourself.
                  </p>
                </div>
              )}
            </Show>
          </section>

          <section class="flex flex-col gap-3" aria-labelledby="project-share-pending">
            <h3 id="project-share-pending" class="text-sm font-medium">
              Pending invitations
            </h3>
            <Show
              when={pending().length}
              fallback={
                <p class="text-sm text-muted-foreground">
                  No invitations are waiting to be accepted.
                </p>
              }
            >
              <ul class="flex flex-col gap-2" aria-label="Pending invitations">
                <For each={pending()}>
                  {(invitation) => (
                    <li class="flex items-center gap-2">
                      <span class="flex min-w-0 flex-1 flex-col">
                        <span class="truncate text-sm">{invitation.email}</span>
                        <span class="text-xs text-muted-foreground">
                          {invitationDetail(invitation)}
                        </span>
                      </span>
                      <AlertDialog>
                        <AlertDialogTrigger
                          as={Button}
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`Revoke the invitation for ${invitation.email}`}
                          disabled={revokeInvitation.isPending}
                        >
                          Revoke
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Revoke this invitation?</AlertDialogTitle>
                            <AlertDialogDescription>
                              The link sent to {invitation.email} stops working immediately. You can
                              create a new one later.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel as={Button} type="button" variant="outline">
                              Keep invitation
                            </AlertDialogCancel>
                            <AlertDialogAction
                              as={Button}
                              type="button"
                              variant="destructive"
                              onClick={() => revoke(invitation)}
                            >
                              Revoke
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </section>
        </Show>

        <Show when={error()}>
          {(message) => (
            <Alert variant="destructive">
              <AlertDescription>{message()}</AlertDescription>
            </Alert>
          )}
        </Show>
      </div>
    </ModalDialog>
  )
}
