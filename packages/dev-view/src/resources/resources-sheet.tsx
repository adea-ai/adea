/*
 * Copyright (c) 2026 Adea contributors.
 *
 * Resources sheet chrome (#424): the host owns the open state and the trigger
 * button, so any view can offer runtime resources. The panel itself is the
 * shared Sheet (Kobalte dialog, end-edge inset docking): Escape, outside
 * click, and focus restoration are the primitive's, the geometry rides the
 * dialog scale, and the pane keeps every row and action it had in the old
 * fixed popover.
 */
import { Suspense, lazy } from 'solid-js'
import { Sheet, SheetBody, SheetContent } from '@adea-ai/ui/components/ui/sheet'

import { createUnavailableDevRuntimeService, type DevRuntimeService } from '../platform'
import './resources-pane.css'

// The pane rides its own lazy chunk inside the Dev boundary: mounting code
// this heavy on the entry chunk would blow the client budget the bundle check
// enforces. It renders only while the sheet is open.
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
  onClose(): void
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
      {/* The pane header carries the visible "Runtime resources" title and the
          refresh action, so the sheet only names the dialog and reserves the
          corner where its close button sits (the dev-resources-sheet wrapper). */}
      <SheetContent
        side="end"
        class="w-150"
        aria-label="Runtime resources"
        closeLabel="Close runtime resources"
      >
        <SheetBody>
          <Suspense fallback={<p class="dev-resources__note">Loading…</p>}>
            <div class="dev-resources-sheet">
              <ResourcesPane
                runtime={props.runtime ?? unavailableRuntime}
                runtimeSessionId={props.runtimeSessionId}
              />
            </div>
          </Suspense>
        </SheetBody>
      </SheetContent>
    </Sheet>
  )
}
