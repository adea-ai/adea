/*
 * New pull request and Git providers dialogs.
 *
 * New pull request opens a draft first (the repository policy default),
 * then applies what the dialog asked for: ready for review, reviewers and
 * labels, and merge when ready. A step that fails after the pull request
 * exists is reported without undoing the creation.
 *
 * Git providers reflects how Adea actually authenticates: GitHub through the
 * `gh` CLI's own credential store. Adea stores no GitHub token.
 */
import type { GitHubAccount, GitHubBranch, GitHubMergeMethod } from '@adea-ai/types/dev-runtime'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { Button } from '@adea-ai/ui/components/ui/button'
import { FormField } from '@adea-ai/ui/components/ui/field'
import { Input } from '@adea-ai/ui/components/ui/input'
import { ModalDialog } from '@adea-ai/ui/components/ui/modal-dialog'
import { NativeSelect } from '@adea-ai/ui/components/ui/native-select'
import { StatusChip } from '@adea-ai/ui/components/ui/status-chip'
import { Switch } from '@adea-ai/ui/components/ui/switch'
import { Textarea } from '@adea-ai/ui/components/ui/textarea'
import { ArrowLeft, Copy } from 'lucide-solid'
import { Show, createEffect, createResource, createSignal, on, type JSX } from 'solid-js'

import { errorText, type ScmClient } from '../client'
import { plural } from '../model/format'
import type { AccountState } from '../state'
import { ChangeCounts } from './bits'
import { Picker, labelLoader, peopleLoader } from './picker'

/** A readable default title from a branch name: `agent/juno/fix-login` → "Fix login". */
export function titleFromBranch(branch: string): string {
  const leaf = branch.split('/').at(-1) ?? branch
  const words = leaf.replace(/[-_]+/g, ' ').trim()
  return words.length > 0 ? words.charAt(0).toUpperCase() + words.slice(1) : branch
}

export function NewPullRequestDialog(props: {
  open: boolean
  repoId: string
  repoLabel: string
  defaultBranch?: string
  headRef?: string
  mergeMethod?: GitHubMergeMethod
  viewer?: string
  client: ScmClient
  onClose(): void
  onCreated(pullRequestId: string): void
  notify(message: string, tone?: 'success' | 'error'): void
}): JSX.Element {
  const [base, setBase] = createSignal('')
  const [head, setHead] = createSignal('')
  const [title, setTitle] = createSignal('')
  const [titleEdited, setTitleEdited] = createSignal(false)
  const [body, setBody] = createSignal('')
  const [reviewers, setReviewers] = createSignal<readonly string[]>([])
  const [labels, setLabels] = createSignal<readonly string[]>([])
  const [draft, setDraft] = createSignal(true)
  const [autoMerge, setAutoMerge] = createSignal(false)
  const [creating, setCreating] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()

  const [branches] = createResource(
    () => (props.open ? props.repoId : undefined),
    (repoId) => props.client.branches(repoId)
  )
  createEffect(
    on(
      () => [props.open, branches()] as const,
      ([open, list]) => {
        if (!open || !list) return
        const defaultBranch =
          props.defaultBranch ??
          list.find((branch) => branch.name === 'main')?.name ??
          list[0]?.name ??
          ''
        if (!base()) setBase(defaultBranch)
        if (!head())
          setHead(
            props.headRef ??
              list.find((branch: GitHubBranch) => branch.name !== defaultBranch)?.name ??
              ''
          )
      }
    )
  )
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (open) return
        setBase('')
        setHead('')
        setTitle('')
        setTitleEdited(false)
        setBody('')
        setReviewers([])
        setLabels([])
        setDraft(true)
        setAutoMerge(false)
        setFailure(undefined)
      }
    )
  )
  createEffect(() => {
    if (!titleEdited() && head()) setTitle(titleFromBranch(head()))
  })

  const [compare] = createResource(
    () =>
      props.open && base() && head() && base() !== head()
        ? { base: base(), head: head() }
        : undefined,
    (source) => props.client.compare(props.repoId, source.base, source.head)
  )

  const options = () =>
    (branches() ?? []).map((branch) => ({ value: branch.name, label: branch.name }))
  const canCreate = () =>
    !creating() &&
    base().length > 0 &&
    head().length > 0 &&
    base() !== head() &&
    title().trim().length > 0 &&
    compare()?.aheadBy !== 0

  const create = async () => {
    setCreating(true)
    setFailure(undefined)
    let created: string | undefined
    try {
      const pr = await props.client.createPullRequest(
        props.repoId,
        head(),
        base(),
        title().trim(),
        body()
      )
      created = pr.id
      const followUps: string[] = []
      if (!draft())
        await props.client
          .update(pr.id, { draft: false })
          .catch((error) => followUps.push(`ready for review (${errorText(error)})`))
      if (reviewers().length > 0 || labels().length > 0)
        await props.client
          .metadataUpdate(pr.id, {
            ...(reviewers().length > 0 ? { reviewers: { add: [...reviewers()], remove: [] } } : {}),
            ...(labels().length > 0 ? { labels: { add: [...labels()], remove: [] } } : {}),
          })
          .catch((error) => followUps.push(`reviewers and labels (${errorText(error)})`))
      if (!draft() && autoMerge()) {
        const summary = await props.client.summary(pr.id, true)
        await props.client
          .autoMerge(pr.id, summary.headSha, true, props.mergeMethod)
          .catch((error) => followUps.push(`merge when ready (${errorText(error)})`))
      }
      props.notify(
        pr.reconciled
          ? 'An open pull request for this branch already existed; opened it.'
          : followUps.length > 0
            ? `Pull request created, but some settings did not apply: ${followUps.join('; ')}.`
            : 'Pull request created.',
        followUps.length > 0 ? 'error' : 'success'
      )
      props.onCreated(pr.id)
    } catch (error) {
      if (created) props.onCreated(created)
      else setFailure(errorText(error))
    } finally {
      setCreating(false)
    }
  }

  return (
    <ModalDialog
      open={props.open}
      onClose={() => props.onClose()}
      title="New pull request"
      description={props.repoLabel}
      class="conventional-dialog"
    >
      <div class="dev-scm-form">
        <div class="dev-scm-form__branches">
          <FormField label="Into" controlId="dev-scm-new-base">
            <NativeSelect
              id="dev-scm-new-base"
              value={base()}
              options={options()}
              disabled={branches.loading}
              onChange={(event) => setBase(event.currentTarget.value)}
            />
          </FormField>
          <ArrowLeft class="mb-2" aria-hidden="true" />
          <FormField label="From" controlId="dev-scm-new-head">
            <NativeSelect
              id="dev-scm-new-head"
              value={head()}
              options={options()}
              disabled={branches.loading}
              onChange={(event) => setHead(event.currentTarget.value)}
            />
          </FormField>
        </div>
        <div class="dev-scm-summary" role="status" aria-live="polite">
          <Show
            when={compare()}
            fallback={
              <span class="dev-scm-caption">
                {branches.error
                  ? `Branches could not be loaded: ${errorText(branches.error)}`
                  : base() && head() && base() === head()
                    ? 'Choose two different branches.'
                    : compare.loading
                      ? 'Comparing branches…'
                      : compare.error
                        ? errorText(compare.error)
                        : 'Choose the branches to compare.'}
              </span>
            }
          >
            {(result) => (
              <>
                <StatusChip
                  tone={
                    result().aheadBy === 0
                      ? 'neutral'
                      : result().behindBy > 0
                        ? 'warning'
                        : 'success'
                  }
                  label={
                    result().aheadBy === 0
                      ? 'Nothing to merge'
                      : result().behindBy > 0
                        ? `${result().behindBy} behind ${base()}`
                        : `Up to date with ${base()}`
                  }
                />
                <span class="dev-scm-caption flex-1">
                  {plural(result().commitCount, 'commit')} · {plural(result().changedFiles, 'file')}
                </span>
                <ChangeCounts additions={result().additions} deletions={result().deletions} />
              </>
            )}
          </Show>
        </div>
        <FormField label="Title" controlId="dev-scm-new-title">
          <Input
            id="dev-scm-new-title"
            value={title()}
            maxLength={256}
            onInput={(event) => {
              setTitle(event.currentTarget.value)
              setTitleEdited(true)
            }}
          />
        </FormField>
        <FormField label="Description" controlId="dev-scm-new-body">
          <Textarea
            id="dev-scm-new-body"
            rows={5}
            value={body()}
            onInput={(event) => setBody(event.currentTarget.value)}
          />
        </FormField>
        <div class="dev-scm-form__grid">
          <FormField label="Reviewers" group>
            <Picker
              noun="reviewers"
              searchLabel="Search people"
              trigger="field"
              selected={reviewers()}
              load={peopleLoader(
                (query) => props.client.assignableUsers(props.repoId, query),
                props.viewer
              )}
              onToggle={(value, add) =>
                setReviewers((current) =>
                  add ? [...current, value] : current.filter((item) => item !== value)
                )
              }
            />
          </FormField>
          <FormField label="Labels" group>
            <Picker
              noun="labels"
              searchLabel="Filter labels"
              trigger="field"
              selected={labels()}
              load={labelLoader(() => props.client.labels(props.repoId))}
              onToggle={(value, add) =>
                setLabels((current) =>
                  add ? [...current, value] : current.filter((item) => item !== value)
                )
              }
            />
          </FormField>
        </div>
        <Switch
          checked={draft()}
          onChange={(value: boolean) => {
            setDraft(value)
            if (value) setAutoMerge(false)
          }}
          label="Open as draft"
          description="Reviewers are not notified until you mark it ready."
        />
        <Switch
          checked={autoMerge()}
          disabled={draft()}
          onChange={setAutoMerge}
          label="Merge when ready"
          description={
            draft()
              ? 'Available once the pull request is not a draft.'
              : 'Merges once approvals and checks are in.'
          }
        />
        <Show when={failure()}>
          <p class="dev-scm-caption" role="alert">
            {failure()}
          </p>
        </Show>
        <div class="dev-scm-form__footer">
          <span class="dev-scm-caption flex-1">Creates the pull request on GitHub.</span>
          <Button type="button" variant="ghost" onClick={() => props.onClose()}>
            Cancel
          </Button>
          <ActionButton
            type="button"
            busy={creating()}
            busyLabel="Creating"
            disabled={!canCreate()}
            onClick={() => void create()}
          >
            Create pull request
          </ActionButton>
        </div>
      </div>
    </ModalDialog>
  )
}

export function ProvidersDialog(props: {
  open: boolean
  account: AccountState
  projectCount: number
  checking: boolean
  onCheck(): void
  onClose(): void
}): JSX.Element {
  const [copied, setCopied] = createSignal(false)
  const connected = (): GitHubAccount | undefined =>
    props.account.status === 'connected' ? props.account.account : undefined
  const copy = () => {
    void navigator.clipboard?.writeText('gh auth login').then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }
  return (
    <ModalDialog
      open={props.open}
      onClose={() => props.onClose()}
      title="Git providers"
      description="Each connected account's organizations appear in the sidebar, with your projects underneath."
      class="conventional-dialog"
    >
      <div class="dev-scm-form">
        <div class="dev-scm-card">
          <div class="dev-scm-provider-row">
            <span class="dev-scm-mark dev-scm-mark--lg" aria-hidden="true">
              GH
            </span>
            <div class="dev-scm-provider-row__text">
              <span class="font-medium">GitHub</span>
              <span class="dev-scm-caption dev-scm-truncate">
                <Show
                  when={connected()}
                  fallback={
                    props.account.status === 'loading'
                      ? 'Checking the GitHub CLI…'
                      : props.account.status === 'disconnected'
                        ? props.account.reason
                        : ''
                  }
                >
                  {(account) =>
                    `Signed in as ${account().login} on ${account().host} · ${plural(props.projectCount, 'project')}`
                  }
                </Show>
              </span>
            </div>
            <StatusChip
              tone={
                connected() ? 'success' : props.account.status === 'loading' ? 'unknown' : 'warning'
              }
              label={
                connected()
                  ? 'Connected'
                  : props.account.status === 'loading'
                    ? 'Checking'
                    : 'Not connected'
              }
            />
            <ActionButton
              type="button"
              variant="outline"
              busy={props.checking}
              busyLabel="Checking"
              onClick={() => props.onCheck()}
            >
              Check again
            </ActionButton>
          </div>
        </div>
        <Show when={!connected() && props.account.status !== 'loading'}>
          <div class="dev-scm-summary">
            <span class="dev-scm-caption flex-1">
              Adea uses the GitHub CLI's sign-in and never stores a GitHub token. Install the GitHub
              CLI, then run this in a terminal:
            </span>
            <span class="dev-scm-mono">gh auth login</span>
            <ActionButton
              type="button"
              variant="ghost"
              size="icon-sm"
              tooltip={copied() ? 'Copied' : 'Copy the command'}
              aria-label="Copy gh auth login"
              onClick={copy}
            >
              <Copy aria-hidden="true" />
            </ActionButton>
          </div>
        </Show>
        <p class="dev-scm-caption">
          Projects appear here when their repository's origin is on GitHub. Add projects in the Dev
          view. GitLab and other providers are not supported yet.
        </p>
        <div class="dev-scm-form__footer">
          <span class="flex-1" />
          <Button type="button" variant="secondary" onClick={() => props.onClose()}>
            Done
          </Button>
        </div>
      </div>
    </ModalDialog>
  )
}
