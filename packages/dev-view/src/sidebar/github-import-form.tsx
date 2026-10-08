/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0.
 *
 * The add surface's "From GitHub" source (ADR 0011): the authenticated gh
 * account's repositories listed through `dev.github.repositories`, a search
 * filter, and a managed `dev.project.clone` per pick. This component issues
 * only those two commands: the listing is a read, and each clone binds the
 * cloud project id the dialog supplies (the host re-proves every admission —
 * transport, unbound project id, budgets — when the clone runs). Clone runs
 * are long: the picked row shows a busy state and typed failures surface as
 * inline error text. Nothing here stores, sends, or displays credential
 * material; the repository list names remotes, never local registrations.
 */
import type { DevCommand, DevOperation, DevReply, Scope } from '@adea-ai/types/dev-runtime'
import { For, Show, createSignal, onMount } from 'solid-js'
import { Search } from 'lucide-solid'

import { buildDevCommand } from '../browser/command'
import {
  filterRepositories,
  managedCloneBodyFor,
  repositoryRows,
  type GitHubImportRow,
} from './github-import-model'
import { Button } from '@adea-ai/ui/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@adea-ai/ui/components/ui/input-group'

export type GitHubImportFormProps = Readonly<{
  scope: Scope
  execute(command: DevCommand): Promise<DevReply>
  onImported(): void
  announce(message: string): void
  /**
   * Supplies the cloud project id the managed clone binds. The register keys
   * every binding by a cloud project id and never mints one; the Dev sidebar
   * passes the project being bound. The default mints a client UUID (a host
   * without a cloud project list falls back to one, like the folder path).
   */
  mintProjectId?: () => string
}>

type ListingState =
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'failed'; message: string }>
  | Readonly<{ status: 'ready'; rows: readonly GitHubImportRow[] }>

export function GitHubImportForm(props: GitHubImportFormProps) {
  const [listing, setListing] = createSignal<ListingState>({ status: 'loading' })
  const [query, setQuery] = createSignal('')
  /** The repository name whose clone is running, if any. */
  const [cloning, setCloning] = createSignal<string>()
  const [error, setError] = createSignal('')

  const readyListing = () => {
    const state = listing()
    return state.status === 'ready' ? state : undefined
  }
  const filtered = () => filterRepositories(readyListing()?.rows ?? [], query())

  const buildCommand = (operation: DevOperation, body: Record<string, unknown>): DevCommand =>
    buildDevCommand({ operation, scope: props.scope, body })

  const loadRepositories = async (): Promise<void> => {
    const reply = await props
      .execute(buildCommand('dev.github.repositories', {}))
      .catch(() => undefined)
    if (!reply) {
      setListing({
        status: 'failed',
        message: 'GitHub repositories are unavailable on this runtime.',
      })
      return
    }
    if (!reply.ok) {
      setListing({ status: 'failed', message: reply.error.message })
      return
    }
    setListing({ status: 'ready', rows: repositoryRows(reply.value as readonly unknown[]) })
  }

  onMount(() => {
    void loadRepositories()
  })

  /** Clone the picked repository into Adea's managed storage and bind it to
   *  the project. Long-running: the row stays busy until the host replies. */
  const importRepository = async (row: GitHubImportRow): Promise<void> => {
    const projectId = props.mintProjectId?.() ?? crypto.randomUUID()
    const body = managedCloneBodyFor(row, projectId)
    if (body === undefined || cloning() !== undefined) return
    setCloning(row.nameWithOwner)
    setError('')
    const reply = await props
      .execute(buildCommand('dev.project.clone', { ...body }))
      .catch((): DevReply => ({
        schemaVersion: 1,
        operation: 'dev.project.clone',
        requestId: '',
        ok: false,
        error: { code: 'unavailable', retryable: true, message: 'The runtime is unavailable.' },
      }))
    setCloning(undefined)
    if (!reply.ok) {
      setError(reply.error.message)
      return
    }
    props.announce(`Cloned ${row.nameWithOwner} into this project.`)
    props.onImported()
  }

  return (
    <div role="group" aria-label="Import a repository from GitHub">
      <p class="dev-tree-empty">
        Pick one of your GitHub repositories. Adea clones it into its own managed storage and binds
        it to this project — no folder on this machine is touched.
      </p>
      <Show when={listing().status === 'loading'}>
        <p class="dev-tree-empty" role="status">
          Loading your GitHub repositories…
        </p>
      </Show>
      <Show when={listing().status === 'failed'}>
        <p class="dev-tree-empty" role="alert">
          {(listing() as { status: 'failed'; message: string }).message}
        </p>
      </Show>
      <Show when={readyListing()}>
        <div class="flex flex-col gap-2">
          <InputGroup class="w-full">
            <InputGroupAddon>
              <Search aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              placeholder="Filter repositories"
              aria-label="Filter GitHub repositories"
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </InputGroup>
          <Show
            when={filtered().length > 0}
            fallback={
              <p class="dev-tree-empty">
                No repository matches this filter. Public, private, and internal repositories of the
                authenticated gh account are listed.
              </p>
            }
          >
            <div class="max-h-64 overflow-y-auto" role="list" aria-label="GitHub repositories">
              <For each={filtered()}>
                {(row) => (
                  <div class="dev-tree-row dev-tree-row--project" role="listitem">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      class="w-full justify-start"
                      disabled={cloning() !== undefined}
                      onClick={() => void importRepository(row)}
                    >
                      <span class="min-w-0 truncate">
                        {cloning() === row.nameWithOwner
                          ? `Cloning ${row.nameWithOwner}…`
                          : row.nameWithOwner}
                      </span>
                      <span class="dev-tree-row__count">
                        {row.visibility}
                        {row.isFork ? ' · fork' : ''}
                      </span>
                    </Button>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <Show when={cloning()}>
            <p class="dev-tree-empty" role="status">
              Cloning {cloning()}… Large repositories can take a while.
            </p>
          </Show>
          <Show when={error() !== ''}>
            <p class="dev-tree-empty" role="alert">
              {error()}
            </p>
          </Show>
        </div>
      </Show>
    </div>
  )
}
