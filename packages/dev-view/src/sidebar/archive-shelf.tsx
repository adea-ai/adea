/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0.
 *
 * Substantially translated from KiroCrew website/src/pages/ChatSidebar.tsx at
 * revision 283e136c0f902e965a535a7c9548c57c7504fed0. Modified for Solid and
 * the dependency-owned archive authority.
 */
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { ListRowControl } from '@adea-ai/ui/components/composites/list-row'
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
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { EmptyDescription } from '@adea-ai/ui/components/ui/empty'
import { ScrollArea } from '@adea-ai/ui/components/ui/scroll-area'
import { Archive } from 'lucide-solid'
import { For, Show, createEffect, createSignal } from 'solid-js'

import { archiveTimeLabel, type ArchiveShelfState } from './archive-shelf-model'

/**
 * The paged archived shelf pinned to the bottom of the shared project/session
 * navigation in Dev, Chat, and Virtual (ADR 0009 product composition). Restore
 * rides the real `dev.session.unarchive` contract and is lossless, so it needs
 * no confirmation; deletion is destructive and always passes an explicit
 * confirmation step, and its commit reports the missing `dev.session.delete`
 * host contract as a typed handoff rather than pretending to succeed.
 */
export function ArchiveShelf(props: {
  state: ArchiveShelfState
  handoffMessage?: string
  /** The shelf disclosure toggled; hosts reload deferred loads on expand. */
  onExpanded?(expanded: boolean): void
  onRestore(runtimeSessionId: string): void
  onRequestDelete(runtimeSessionId: string): void
  onCancelDelete(): void
  onConfirmDelete(): void
}) {
  const [expanded, setExpanded] = createSignal(false)
  const pending = () => props.state.pendingDeleteId
  let shelfToggle: HTMLButtonElement | undefined
  let restoring: { id: string; button: HTMLButtonElement } | undefined

  // A successful unarchive removes its row. Return focus to the persistent
  // shelf control only when the user has not moved on during the request.
  createEffect(() => {
    const items = props.state.items
    const target = restoring
    if (!target || items.some((item) => item.id === target.id)) return
    restoring = undefined
    if (typeof document === 'undefined') return
    const active = document.activeElement
    if (active !== target.button && (target.button.isConnected || active !== document.body)) return
    queueMicrotask(() => {
      if (document.activeElement === target.button || document.activeElement === document.body) {
        shelfToggle?.focus()
      }
    })
  })
  return (
    <section class="w-full">
      <ActionButton
        ref={(element) => {
          shelfToggle = element
        }}
        type="button"
        variant="ghost"
        size="sm"
        tooltip={expanded() ? 'Hide archived sessions' : 'Show archived sessions'}
        class="w-full justify-start"
        aria-expanded={expanded()}
        aria-controls="dev-archive-shelf-content"
        onClick={() =>
          setExpanded((value) => {
            const next = !value
            props.onExpanded?.(next)
            return next
          })
        }
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
            <Show when={props.state.status === 'error'}>
              <Alert variant="destructive" role="alert">
                <AlertDescription>
                  Archived sessions could not be loaded ({props.state.reason ?? 'provider error'}).
                  {props.state.items.length > 0
                    ? ' Previously loaded sessions remain available.'
                    : ''}
                </AlertDescription>
              </Alert>
            </Show>
            <Show
              when={props.state.items.length > 0}
              fallback={
                <Show when={props.state.status === 'ready'}>
                  <EmptyDescription>No archived sessions.</EmptyDescription>
                </Show>
              }
            >
              <ul class="flex flex-col gap-1" aria-label="Archived sessions">
                <For each={props.state.items}>
                  {(item) => {
                    // ListRowControl reads its trailing prop twice (Show condition
                    // and insert); construct the fragment once so both reads share
                    // a single AlertDialog instance.
                    const trailing = (
                      <>
                        <ActionButton
                          type="button"
                          variant="outline"
                          size="xs"
                          tooltip="Restore this archived session"
                          onClick={(event) => {
                            restoring = { id: item.id, button: event.currentTarget }
                            props.onRestore(item.id)
                          }}
                        >
                          Restore
                        </ActionButton>
                        <AlertDialog
                          open={pending() === item.id}
                          onOpenChange={(open) => {
                            if (open) props.onRequestDelete(item.id)
                          }}
                        >
                          <AlertDialogTrigger
                            as={ActionButton}
                            type="button"
                            variant="destructive"
                            size="xs"
                            tooltip="Delete this archived session"
                          >
                            Delete…
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete this archived session?</AlertDialogTitle>
                              <AlertDialogDescription>
                                This build cannot permanently delete sessions. Choosing Delete
                                explains the unavailable action and keeps “{item.title}” archived.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel
                                as={ActionButton}
                                type="button"
                                variant="outline"
                                tooltip="Cancel deletion of this archived session"
                                onClick={() => props.onCancelDelete()}
                              >
                                Keep
                              </AlertDialogCancel>
                              <AlertDialogAction
                                as={ActionButton}
                                type="button"
                                variant="destructive"
                                tooltip="Confirm deletion of this archived session"
                                onClick={() => props.onConfirmDelete()}
                              >
                                Delete
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </>
                    )
                    return (
                      <li class="flex flex-col gap-1">
                        <ListRowControl
                          description={archiveTimeLabel(item.archivedAt)}
                          trailing={trailing}
                        >
                          {item.title}
                        </ListRowControl>
                      </li>
                    )
                  }}
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
