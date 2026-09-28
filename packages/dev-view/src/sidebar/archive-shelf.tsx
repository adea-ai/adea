/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0.
 *
 * Substantially translated from KiroCrew website/src/pages/ChatSidebar.tsx at
 * revision 283e136c0f902e965a535a7c9548c57c7504fed0. Modified for Solid and
 * the dependency-owned archive authority.
 */
import { cn } from '@adea-ai/app-ui/lib/utils'
import { Archive } from 'lucide-solid'
import { For, Show, createSignal } from 'solid-js'

import type { ArchiveShelfState } from './archive-shelf-model'

/**
 * The paged archived shelf pinned to the bottom of the Dev sidebar (ADR 0009
 * product composition). Restore rides the real `dev.session.unarchive`
 * contract and is lossless, so it needs no confirmation; deletion is
 * destructive and always passes an explicit confirmation step, and its commit
 * reports the missing `dev.session.delete` host contract as a typed handoff
 * rather than pretending to succeed.
 */
export function ArchiveShelf(props: {
  state: ArchiveShelfState
  handoffMessage?: string
  onRestore(runtimeSessionId: string): void
  onRequestDelete(runtimeSessionId: string): void
  onCancelDelete(): void
  onConfirmDelete(): void
}) {
  const [expanded, setExpanded] = createSignal(false)
  const pending = () => props.state.pendingDeleteId
  return (
    <section class="dev-archive-shelf">
      <button
        type="button"
        class="dev-tree-row dev-tree-row--archive"
        aria-expanded={expanded()}
        aria-controls="dev-archive-shelf-content"
        onClick={() => setExpanded((value) => !value)}
      >
        <Archive aria-hidden="true" /> Archived sessions
        <Show when={props.state.items.length > 0}>
          <span class="dev-tree-row__count">{props.state.items.length}</span>
        </Show>
      </button>
      <Show when={expanded()}>
        <div id="dev-archive-shelf-content" class="dev-archive-shelf__content">
          <Show
            when={props.state.status === 'ready' || props.state.status === 'error'}
            fallback={
              <p class="dev-tree-empty" role="status">
                {props.state.status === 'loading'
                  ? 'Loading archived sessions…'
                  : props.state.status === 'unavailable'
                    ? `Archived sessions are unavailable (${props.state.reason ?? 'provider unavailable'}).`
                    : 'Loading archived sessions…'}
              </p>
            }
          >
            <Show
              when={props.state.items.length > 0}
              fallback={<p class="dev-tree-empty">No archived sessions.</p>}
            >
              <ul class="dev-archive-shelf__list" aria-label="Archived sessions">
                <For each={props.state.items}>
                  {(item) => (
                    <li class="dev-archive-shelf__item">
                      <span class="dev-tree-row__title" title={item.archivedAt}>
                        {item.title}
                      </span>
                      <span class="dev-archive-shelf__actions">
                        <Show
                          when={pending() === item.id}
                          fallback={
                            <>
                              <button
                                type="button"
                                class="dev-archive-action"
                                onClick={() => props.onRestore(item.id)}
                              >
                                Restore
                              </button>
                              <button
                                type="button"
                                class="dev-archive-action dev-archive-action--destructive"
                                onClick={() => props.onRequestDelete(item.id)}
                              >
                                Delete…
                              </button>
                            </>
                          }
                        >
                          <span class="dev-archive-shelf__confirm" role="alert">
                            Delete this archived session?
                            <button
                              type="button"
                              class="dev-archive-action dev-archive-action--destructive"
                              onClick={() => props.onConfirmDelete()}
                            >
                              Delete
                            </button>
                            <button
                              type="button"
                              class="dev-archive-action"
                              onClick={() => props.onCancelDelete()}
                            >
                              Keep
                            </button>
                          </span>
                        </Show>
                      </span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show when={props.handoffMessage}>
              <p class={cn('dev-archive-shelf__handoff')} role="note">
                {props.handoffMessage}
              </p>
            </Show>
          </Show>
        </div>
      </Show>
    </section>
  )
}
