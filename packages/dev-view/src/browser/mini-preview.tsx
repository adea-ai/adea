/*
 * Browser preview shell (#422). The shared FloatingPreview owns bounded drag,
 * resize, and keyboard movement; this pane supplies only its lane summary.
 */
import { Show } from 'solid-js'

import type { BrowserLane } from '@adea-ai/types/dev-runtime'
import { FloatingPreview } from '@adea-ai/ui/components/layout/floating-preview'

import { LANE_KIND_LABEL } from './lane-kind-label'
import { resolveDeviceMiniPlayerSourceSize } from './mini-preview-layout'

const PLACEHOLDER_SOURCE = resolveDeviceMiniPlayerSourceSize('ios', null)

export function MiniPreview(props: { lane?: BrowserLane; onClose(): void }) {
  return (
    // The host hook container (`.dev-browser-mini` in browser-pane.css) sizes
    // the published header band to its Move control; the preview itself
    // positions against the pane exactly as it would unwrapped.
    <div class="dev-browser-mini">
      <FloatingPreview label="Browser preview" source={PLACEHOLDER_SOURCE} onClose={props.onClose}>
        <div
          class="dev-browser-mini__viewport"
          data-empty={props.lane ? 'false' : 'true'}
          role="status"
        >
          <Show when={props.lane} fallback={<span>No lane attached</span>}>
            {(lane) => (
              <span class="dev-terminal-muted">
                Mirroring {LANE_KIND_LABEL[lane().kind]} · gen {lane().generation}
              </span>
            )}
          </Show>
        </div>
      </FloatingPreview>
    </div>
  )
}
