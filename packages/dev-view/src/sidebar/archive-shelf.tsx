/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0.
 *
 * Substantially translated from KiroCrew website/src/pages/ChatSidebar.tsx at
 * revision 283e136c0f902e965a535a7c9548c57c7504fed0. Modified for Solid and
 * the dependency-owned archive authority.
 */
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { ListRowControl } from '@adea-ai/ui/components/composites/list-row/list-row-control'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { EmptyDescription } from '@adea-ai/ui/components/ui/empty'
import { ScrollArea } from '@adea-ai/ui/components/ui/scroll-area'
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
    <section class="w-full">
      <ActionButton
        type="button"
        variant="ghost"
        size="sm"
        tooltip={expanded() ? 'Hide archived sessions' : 'Show archived sessions'}
        class="w-full justify-start"
        aria-expanded={expanded()}
        aria-controls="dev-archive-shelf-content"
        onClick={() => setExpanded((value) => !value)}
      >
        <Archive aria-hidden="true" /> Archived sessions
        <Show when={props.state.items.length > 0}>
          <Badge class="ms-auto" size="sm" variant="secondary">
            {props.state.items.length}
          </Badge>
        </Show>
      </ActionButton>
      <Show when={expanded()}>
        <ScrollArea
          id="dev-archive-shelf-content"
          class="max-h-56"
          aria-label="Archived sessions"
          role="region"
        >
          <Show
            when={props.state.status === 'ready' || props.state.status === 'error'}
            fallback={
              <EmptyDescription role="status">
                {props.state.status === 'loading'
                  ? 'Loading archived sessions…'
                  : props.state.status === 'unavailable'
                    ? `Archived sessions are unavailable (${props.state.reason ?? 'provider unavailable'}).`
                    : 'Loading archived sessions…'}
              </EmptyDescription>
            }
          >
            <Show
              when={props.state.items.length > 0}
              fallback={<EmptyDescription>No archived sessions.</EmptyDescription>}
            >
              <ul class="flex flex-col gap-1" aria-label="Archived sessions">
                <For each={props.state.items}>
                  {(item) => (
                    <li class="flex flex-col gap-1">
                      <ListRowControl
                        description={item.archivedAt}
                        trailing={
                          <Show when={pending() !== item.id}>
                            <>
                              <ActionButton
                                type="button"
                                variant="outline"
                                size="xs"
                                tooltip="Restore this archived session"
                                onClick={() => props.onRestore(item.id)}
                              >
                                Restore
                              </ActionButton>
                              <ActionButton
                                type="button"
                                variant="destructive"
                                size="xs"
                                tooltip="Delete this archived session"
                                onClick={() => props.onRequestDelete(item.id)}
                              >
                                Delete…
                              </ActionButton>
                            </>
                          </Show>
                        }
                      >
                        {item.title}
                      </ListRowControl>
                      <Show when={pending() === item.id}>
                        <Alert variant="warning">
                          <AlertDescription>
                            <p>Delete this archived session?</p>
                            <div class="flex flex-wrap gap-1 mt-1">
                              <ActionButton
                                type="button"
                                variant="destructive"
                                size="xs"
                                tooltip="Confirm deletion of this archived session"
                                onClick={() => props.onConfirmDelete()}
                              >
                                Delete
                              </ActionButton>
                              <ActionButton
                                type="button"
                                variant="outline"
                                size="xs"
                                tooltip="Cancel deletion of this archived session"
                                onClick={() => props.onCancelDelete()}
                              >
                                Keep
                              </ActionButton>
                            </div>
                          </AlertDescription>
                        </Alert>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show when={props.handoffMessage}>
              <Alert role="note">
                <AlertDescription>{props.handoffMessage}</AlertDescription>
              </Alert>
            </Show>
          </Show>
        </ScrollArea>
      </Show>
    </section>
  )
}
