/*
 * Copyright (c) 2026 Adea contributors.
 *
 * Resources sheet chrome (#424): the dismissible panel that hosts the lazy
 * ResourcesPane. The host owns the open state and the trigger button, so any
 * view can offer runtime resources — the sheet only anchors top-right below
 * the top bar and reports Escape.
 */
import { X } from 'lucide-solid'
import { Suspense, lazy } from 'solid-js'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'

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
    <div
      class="dev-resources-sheet"
      role="dialog"
      aria-label="Runtime resources"
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key === 'Escape') props.onClose()
      }}
    >
      <div class="dev-resources-sheet__bar">
        <span>Runtime resources</span>
        <ActionButton
          type="button"
          variant="outline"
          size="icon-sm"
          tooltip="Close runtime resources"
          aria-label="Close runtime resources"
          onClick={props.onClose}
        >
          <X aria-hidden="true" />
        </ActionButton>
      </div>
      <Suspense fallback={<p class="dev-resources__note">Loading…</p>}>
        <ResourcesPane
          runtime={props.runtime ?? unavailableRuntime}
          runtimeSessionId={props.runtimeSessionId}
        />
      </Suspense>
    </div>
  )
}
