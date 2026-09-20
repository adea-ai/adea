/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0.
 *
 * Sidebar repository registry surface (#398 follow-up client wiring). The
 * panel reads the authoritative registry through the authenticated command
 * path only — `dev.project.list`, `dev.repo.list`, `dev.project.bookmarks`,
 * and `dev.repo.credentialRefs` — and decodes every reply item through the
 * strict provider-owned decoders before rendering; a success value that fails
 * strict decode fails closed as a registry error, never as a guessed row.
 *
 * Mutations are explicit user actions:
 *  - `dev.repo.adopt` re-proves a binding under an owner-picked authorized
 *    bookmark (the binding's own bookmark is the default; never a path).
 *  - `dev.repo.authorize` binds a vaulted credential reference to the remote
 *    host; the picker lists `CredentialRef` ids only — secret material never
 *    enters the client.
 *  - `dev.repo.inspect` / `dev.repo.refresh` surface the typed lifecycle
 *    (`stale`/`unavailable` are truths, not failures to hide).
 *  - `dev.project.archive` flips the navigation lifecycle behind the same
 *    explicit confirmation gate the archive shelf uses; refusals (live
 *    sessions, stale version) surface as typed non-blocking notices.
 * A runtime without the registry providers answers `capability_unavailable`;
 * the panel renders that typed state instead of dead controls. This module
 * rides its own lazy chunk (client budget), so it stays dependency-light.
 */
import { cn } from '@adea-ai/ui/lib/utils'
import type {
  CredentialRef,
  DevCommand,
  DevOperation,
  DevReply,
  RootBookmark,
  Scope,
} from '@adea-ai/types/dev-runtime'
import {
  decodeCredentialRef,
  decodeProject,
  decodeRepo,
  decodeRepoInspection,
  decodeRootBookmark,
} from '@adea-ai/types/dev-runtime'
import { For, Show, createSignal, onMount } from 'solid-js'

import { buildDevCommand } from '../browser/command'
import {
  archiveNoticeForError,
  beginRegistryLoad,
  cancelPendingArchive,
  confirmPendingArchive,
  credentialRefsForHost,
  defaultAdoptBookmarkId,
  expectedRepoVersion,
  inspectionLine,
  lifecycleBadge,
  projectBindings,
  registryError,
  registryReady,
  registryUnavailable,
  registryUnavailableNotice,
  repoBaseName,
  repoCommandNotice,
  repoRows,
  requestArchive,
  type RepoRegistryRow,
  type RepoRegistryState,
} from './repo-registry-model'

export type RepoRegistryPanelProps = Readonly<{
  scope: Scope
  execute(command: DevCommand): Promise<DevReply>
  announce(message: string): void
}>

type Notice = Readonly<{ tone: 'status' | 'alert'; text: string }>

export function RepoRegistryPanel(props: RepoRegistryPanelProps) {
  const [state, setState] = createSignal<RepoRegistryState>(beginRegistryLoad())
  const [bookmarks, setBookmarks] = createSignal<readonly RootBookmark[]>([])
  const [credentials, setCredentials] = createSignal<readonly CredentialRef[]>([])
  const [notice, setNotice] = createSignal<Notice>()
  const [adoptPickerRepo, setAdoptPickerRepo] = createSignal('')
  const [adoptBookmarkId, setAdoptBookmarkId] = createSignal('')
  const [authorizePickerRepo, setAuthorizePickerRepo] = createSignal('')
  const [authorizeCredentialId, setAuthorizeCredentialId] = createSignal('')
  const [busy, setBusy] = createSignal('')

  /** One authenticated registry read; items pass their strict decoder. */
  const readRegistryPage = async <T,>(
    operation: DevOperation,
    body: Record<string, unknown>,
    decodeItem: (value: unknown) => T
  ): Promise<readonly T[]> => {
    const command = buildDevCommand({ operation, scope: props.scope, body })
    const reply = await props.execute(command)
    if (!reply.ok) throw reply.error
    const page = reply.value as { items: readonly unknown[] }
    return page.items.map((item) => decodeItem(item))
  }

  const withBusy = async (key: string, run: () => Promise<void>): Promise<void> => {
    if (busy() !== '') return
    setBusy(key)
    try {
      await run()
    } finally {
      setBusy('')
    }
  }

  const load = async (): Promise<void> => {
    try {
      const [projects, repos, roots, refs] = await Promise.all([
        readRegistryPage('dev.project.list', {}, decodeProject),
        readRegistryPage('dev.repo.list', {}, decodeRepo),
        readRegistryPage('dev.project.bookmarks', {}, decodeRootBookmark),
        readRegistryPage('dev.repo.credentialRefs', {}, decodeCredentialRef),
      ])
      setBookmarks(roots)
      setCredentials(refs)
      setState(registryReady(repoRows(projectBindings(projects), repos), projects))
    } catch (error) {
      if (error instanceof TypeError) {
        // A strict decoder refused a success value: fail closed, never render.
        setState(registryError('registry data failed strict decode', state()))
        setNotice({ tone: 'alert', text: 'Registry data failed strict decoding.' })
        return
      }
      const refused = error as { code?: string }
      const code = typeof refused.code === 'string' ? refused.code : 'unavailable'
      setState(registryUnavailable(registryUnavailableNotice(code)))
    }
  }

  onMount(() => {
    void load()
  })

  const openAdoptPicker = (row: RepoRegistryRow) => {
    setAdoptPickerRepo(row.repoId)
    setAdoptBookmarkId(defaultAdoptBookmarkId(row, bookmarks()))
    setAuthorizePickerRepo('')
    setNotice(undefined)
  }

  const adopt = (row: RepoRegistryRow) =>
    void withBusy(`adopt:${row.repoId}`, async () => {
      const rootBookmarkId = adoptBookmarkId()
      if (rootBookmarkId === '') {
        setNotice({ tone: 'alert', text: 'Pick an authorized repository bookmark first.' })
        return
      }
      // The initial version of a not-yet-materialized binding is 1; an
      // adopted record re-proofs at its current version.
      const expectedVersion = expectedRepoVersion(row)
      const reply = await props.execute(
        buildDevCommand({
          operation: 'dev.repo.adopt',
          scope: props.scope,
          body: { repoId: row.repoId, rootBookmarkId, expectedVersion },
          resource: { kind: 'repository', id: row.repoId, generation: expectedVersion },
        })
      )
      if (!reply.ok) {
        setNotice({ tone: 'alert', text: repoCommandNotice('Adopt', reply.error) })
        return
      }
      decodeRepo(reply.value)
      setAdoptPickerRepo('')
      props.announce(`Repository ${repoBaseName(row.canonicalRoot)} adopted.`)
      await load()
    })

  const openAuthorizePicker = (row: RepoRegistryRow) => {
    const host = row.record?.remote?.host
    if (host === undefined) return
    setAuthorizePickerRepo(row.repoId)
    setAuthorizeCredentialId(credentialRefsForHost(credentials(), host)[0]?.id ?? '')
    setAdoptPickerRepo('')
    setNotice(undefined)
  }

  const authorize = (row: RepoRegistryRow) =>
    void withBusy(`authorize:${row.repoId}`, async () => {
      const host = row.record?.remote?.host
      const credentialRefId = authorizeCredentialId()
      if (host === undefined || credentialRefId === '') {
        setNotice({
          tone: 'alert',
          text: `No ready vault credential is available for ${host ?? 'the remote host'}.`,
        })
        return
      }
      const expectedVersion = expectedRepoVersion(row)
      const reply = await props.execute(
        buildDevCommand({
          operation: 'dev.repo.authorize',
          scope: props.scope,
          body: { repoId: row.repoId, credentialRefId, expectedVersion },
          resource: { kind: 'repository', id: row.repoId, generation: expectedVersion },
        })
      )
      if (!reply.ok) {
        setNotice({ tone: 'alert', text: repoCommandNotice('Authorize', reply.error) })
        return
      }
      decodeRepo(reply.value)
      setAuthorizePickerRepo('')
      props.announce(`Credential bound for ${repoBaseName(row.canonicalRoot)}.`)
      await load()
    })

  const inspect = (row: RepoRegistryRow) =>
    void withBusy(`inspect:${row.repoId}`, async () => {
      const expectedVersion = expectedRepoVersion(row)
      const reply = await props.execute(
        buildDevCommand({
          operation: 'dev.repo.inspect',
          scope: props.scope,
          body: { repoId: row.repoId },
          resource: { kind: 'repository', id: row.repoId, generation: expectedVersion },
        })
      )
      if (!reply.ok) {
        setNotice({ tone: 'alert', text: repoCommandNotice('Inspect', reply.error) })
        return
      }
      const inspection = decodeRepoInspection(reply.value)
      setState((current) => ({
        ...current,
        rows: current.rows.map((entry) =>
          entry.repoId === row.repoId ? { ...entry, inspection } : entry
        ),
      }))
      props.announce(`Inspected ${repoBaseName(row.canonicalRoot)}: ${inspectionLine(inspection)}`)
    })

  const refresh = (row: RepoRegistryRow) =>
    void withBusy(`refresh:${row.repoId}`, async () => {
      const expectedVersion = expectedRepoVersion(row)
      const reply = await props.execute(
        buildDevCommand({
          operation: 'dev.repo.refresh',
          scope: props.scope,
          body: { repoId: row.repoId, expectedVersion },
          resource: { kind: 'repository', id: row.repoId, generation: expectedVersion },
        })
      )
      if (!reply.ok) {
        setNotice({ tone: 'alert', text: repoCommandNotice('Refresh', reply.error) })
        return
      }
      const repo = decodeRepo(reply.value)
      // A stale or unavailable lifecycle is typed truth, not hidden failure.
      setNotice({
        tone: repo.lifecycle === 'ready' ? 'status' : 'alert',
        text:
          repo.lifecycle === 'ready'
            ? `Refreshed ${repoBaseName(row.canonicalRoot)}; remote re-proven.`
            : `Refreshed ${repoBaseName(row.canonicalRoot)}: remote could not be re-proven (${repo.lifecycle}).`,
      })
      await load()
    })

  const confirmArchive = (projectId: string) => {
    const commit = confirmPendingArchive(state())
    setState(commit.state)
    const project = state().projects.find((entry) => entry.id === projectId)
    if (!project) return
    void withBusy(`archive:${project.id}`, async () => {
      const archived = project.lifecycle !== 'archived'
      const reply = await props.execute(
        buildDevCommand({
          operation: 'dev.project.archive',
          scope: props.scope,
          body: { projectId: project.id, expectedVersion: project.version, archived },
          resource: { kind: 'project', id: project.id, generation: project.version },
        })
      )
      if (!reply.ok) {
        setNotice({ tone: 'alert', text: archiveNoticeForError(reply.error) })
        await load()
        return
      }
      decodeProject(reply.value)
      props.announce(
        `${project.name} ${archived ? 'archived' : 'restored'}; navigation only, nothing was stopped or deleted.`
      )
      await load()
    })
  }

  return (
    <details class="dev-tree-group">
      <summary class="dev-tree-row dev-tree-row--group">
        Repositories
        <Show when={state().rows.length > 0}>
          <span class="dev-tree-row__count">{state().rows.length}</span>
        </Show>
      </summary>
      <Show when={notice()}>
        {(shown) => (
          <p class="dev-tree-empty" role={shown().tone === 'alert' ? 'alert' : 'status'}>
            {shown().text}
          </p>
        )}
      </Show>
      <Show
        when={state().status === 'ready' || state().status === 'error'}
        fallback={
          <p class="dev-tree-empty" role="status">
            {state().status === 'loading'
              ? 'Loading repository registry…'
              : (state().reason ?? 'Repositories are unavailable.')}
          </p>
        }
      >
        <Show
          when={state().rows.length > 0}
          fallback={
            <p class="dev-tree-empty">No repository bindings yet. Import a project first.</p>
          }
        >
          <ul aria-label="Registered repositories">
            <For each={state().rows}>
              {(row) => {
                const badge = () => lifecycleBadge(row.lifecycle)
                const host = () => row.record?.remote?.host
                const pickerCredentials = () =>
                  host() === undefined ? [] : credentialRefsForHost(credentials(), host()!)
                return (
                  <li class="dev-tree-row dev-tree-row--project" data-repo-id={row.repoId}>
                    <span class="dev-tree-row__title" title={row.canonicalRoot}>
                      {repoBaseName(row.canonicalRoot)}
                    </span>
                    <span
                      class={cn(
                        'dev-row-badge',
                        badge().tone === 'success' && 'dev-row-badge--success',
                        badge().tone === 'failure' && 'dev-row-badge--failure',
                        badge().tone === 'progress' && 'dev-row-badge--progress'
                      )}
                    >
                      {badge().label}
                    </span>
                    <Show when={row.record?.remote}>
                      <p class="dev-tree-empty">
                        {row.record?.remote?.displayUrl}
                        <Show when={row.record?.defaultRef}> · {row.record?.defaultRef}</Show>
                      </p>
                    </Show>
                    <Show when={row.inspection}>
                      <p class="dev-tree-empty" role="status">
                        {inspectionLine(row.inspection!)}
                      </p>
                    </Show>
                    <Show
                      when={adoptPickerRepo() === row.repoId}
                      fallback={
                        <span class="dev-archive-shelf__actions">
                          <Show
                            when={row.lifecycle === 'binding-only'}
                            fallback={
                              <>
                                <button
                                  type="button"
                                  class="dev-archive-action"
                                  disabled={busy() !== ''}
                                  onClick={() => void inspect(row)}
                                >
                                  Inspect
                                </button>
                                <button
                                  type="button"
                                  class="dev-archive-action"
                                  disabled={busy() !== ''}
                                  onClick={() => void refresh(row)}
                                >
                                  Refresh
                                </button>
                                <Show when={host() !== undefined}>
                                  <button
                                    type="button"
                                    class="dev-archive-action"
                                    disabled={busy() !== ''}
                                    onClick={() => openAuthorizePicker(row)}
                                  >
                                    Authorize…
                                  </button>
                                </Show>
                              </>
                            }
                          >
                            <button
                              type="button"
                              class="dev-archive-action"
                              disabled={busy() !== ''}
                              onClick={() => openAdoptPicker(row)}
                            >
                              Adopt…
                            </button>
                          </Show>
                        </span>
                      }
                    >
                      <span
                        class="dev-archive-shelf__confirm"
                        role="group"
                        aria-label="Adopt repository"
                      >
                        <label>
                          <span class="sr-only">Authorized bookmark for adoption</span>
                          <select
                            value={adoptBookmarkId()}
                            onChange={(event) => setAdoptBookmarkId(event.currentTarget.value)}
                          >
                            <For
                              each={bookmarks().filter(
                                (bookmark) =>
                                  bookmark.state === 'active' && bookmark.kind === 'repository'
                              )}
                            >
                              {(bookmark) => <option value={bookmark.id}>{bookmark.label}</option>}
                            </For>
                          </select>
                        </label>
                        <button
                          type="button"
                          class="dev-archive-action"
                          disabled={busy() !== ''}
                          onClick={() => void adopt(row)}
                        >
                          Adopt
                        </button>
                        <button
                          type="button"
                          class="dev-archive-action"
                          onClick={() => setAdoptPickerRepo('')}
                        >
                          Cancel
                        </button>
                      </span>
                    </Show>
                    <Show when={authorizePickerRepo() === row.repoId}>
                      <span
                        class="dev-archive-shelf__confirm"
                        role="group"
                        aria-label="Authorize credential"
                      >
                        <label>
                          <span class="sr-only">Vault credential reference</span>
                          <select
                            value={authorizeCredentialId()}
                            onChange={(event) =>
                              setAuthorizeCredentialId(event.currentTarget.value)
                            }
                          >
                            <For each={pickerCredentials()}>
                              {(ref) => (
                                <option value={ref.id}>
                                  {ref.label} ({ref.kind})
                                </option>
                              )}
                            </For>
                          </select>
                        </label>
                        <button
                          type="button"
                          class="dev-archive-action"
                          disabled={busy() !== '' || authorizeCredentialId() === ''}
                          onClick={() => void authorize(row)}
                        >
                          Authorize
                        </button>
                        <button
                          type="button"
                          class="dev-archive-action"
                          onClick={() => setAuthorizePickerRepo('')}
                        >
                          Cancel
                        </button>
                      </span>
                    </Show>
                  </li>
                )
              }}
            </For>
          </ul>
        </Show>
        <Show when={state().projects.length > 0}>
          <p class="dev-tree-empty" role="presentation">
            Project archive
          </p>
          <ul aria-label="Project archive">
            <For each={state().projects}>
              {(project) => {
                const archived = () => project.lifecycle === 'archived'
                const pending = () => state().pendingArchiveProjectId === project.id
                return (
                  <li class="dev-tree-row dev-tree-row--project" data-project-id={project.id}>
                    <span class="dev-tree-row__title">{project.name}</span>
                    <Show
                      when={!pending()}
                      fallback={
                        <span
                          class="dev-archive-shelf__confirm"
                          role="alert"
                          aria-label={`Confirm archiving ${project.name}`}
                        >
                          Archive this project?
                          <button
                            type="button"
                            class="dev-archive-action dev-archive-action--destructive"
                            disabled={busy() !== ''}
                            onClick={() => confirmArchive(project.id)}
                          >
                            {archived() ? 'Unarchive' : 'Archive'}
                          </button>
                          <button
                            type="button"
                            class="dev-archive-action"
                            onClick={() => setState(cancelPendingArchive(state()))}
                          >
                            Keep
                          </button>
                        </span>
                      }
                    >
                      <span class="dev-archive-shelf__actions">
                        <button
                          type="button"
                          class={cn(
                            'dev-archive-action',
                            !archived() && 'dev-archive-action--destructive'
                          )}
                          disabled={busy() !== ''}
                          onClick={() => setState(requestArchive(state(), project.id))}
                        >
                          {archived() ? 'Unarchive' : 'Archive…'}
                        </button>
                      </span>
                    </Show>
                  </li>
                )
              }}
            </For>
          </ul>
        </Show>
      </Show>
    </details>
  )
}
