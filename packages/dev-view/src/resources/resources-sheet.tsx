/*
 * Copyright (c) 2026 Adea contributors.
 *
 * Resources sheet chrome (#424): the host owns the open state and the trigger
 * button, so any view can offer runtime resources. The panel itself is the
 * shared Sheet (Kobalte dialog, end-edge inset docking): Escape, outside
 * click, and focus restoration are the primitive's, the geometry rides the
 * dialog scale, and the pane keeps every row and action it had in the old
 * fixed popover.
 *
 * The pinned title/action bands and the scrolling body are the pane's
 * (published SheetHeader/SheetBody/SheetFooter parts, #1082's two-toned
 * bands), and the pane rides its own lazy chunk — so while it loads this
 * composition renders the same SheetContent shape with a loading body, and
 * the loaded pane swaps in its full chrome.
 */
import { Suspense, lazy } from 'solid-js'
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@adea-ai/ui/components/ui/sheet'

import { createUnavailableDevRuntimeService, type DevRuntimeService } from '../platform'
import './resources-pane.css'

// The pane rides its own lazy chunk inside the Dev boundary: mounting code
// this heavy on the entry chunk would blow the client budget the bundle check
// enforces. It renders the whole sheet content while the sheet is open.
const ResourcesPane = lazy(() =>
  import('./resources-pane').then((module) => ({ default: module.ResourcesPane }))
)

// Lanes without a Dev runtime channel (the browser lane) still get the sheet;
// the pane reports the typed unavailable state instead of fabricating data.
const unavailableRuntime = createUnavailableDevRuntimeService({
  reason: 'channel_unauthenticated',
})

export type ResourcesSheetProps = {
  /** Absent when the host lane has no Dev runtime channel. */
  runtime?: DevRuntimeService
  runtimeSessionId?: string
  /** Opens a link outside the app; see `ResourcesPaneProps.openExternal`. */
  openExternal?: (url: string) => Promise<void> | void
  /** Focuses a runtime session in Dev; the sheet closes first so the
   * session is visible. */
  onOpenSession?: (target: { runtimeSessionId: string; projectId?: string }) => void
  onClose(): void
}

/** The same panel shape as the loaded pane, without its state: the sheet is
 * visible (and dismissible) from the first frame, the title band never jumps,
 * and the body explains the wait. */
function ResourcesSheetPending() {
  return (
    <SheetContent side="end" class="w-150" closeLabel="Close runtime resources">
      <SheetHeader>
        <SheetTitle>Runtime resources</SheetTitle>
      </SheetHeader>
      <SheetBody>
        <p class="dev-resources__note">Loading…</p>
      </SheetBody>
    </SheetContent>
  )
}

export function ResourcesSheet(props: ResourcesSheetProps) {
  return (
    // `open` is always true here: the host conditionally mounts the sheet, so
    // dismissing (Escape, outside click, close button) reports through
    // onOpenChange and the host unmounts.
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
    >
      <Suspense fallback={<ResourcesSheetPending />}>
        <ResourcesPane
          runtime={props.runtime ?? unavailableRuntime}
          runtimeSessionId={props.runtimeSessionId}
          openExternal={props.openExternal}
          {...(props.onOpenSession
            ? {
                onOpenSession: (target: { runtimeSessionId: string; projectId?: string }) => {
                  props.onClose()
                  props.onOpenSession?.(target)
                },
              }
            : {})}
        />
      </Suspense>
    </Sheet>
  )
}
