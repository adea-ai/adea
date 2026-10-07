import { EntityIcon } from '@adea-ai/ui/components/ui/entity-icon'
import { createEffect, createSignal, Show } from 'solid-js'
import { Box, House } from 'lucide-solid'

import { useOptionalTheme } from './theme-provider'
import { paintAppearanceAccent, paintWorkspaceAccent } from './workspace-accent'

export type WorkspaceIdentityLogo =
  | Readonly<{ kind: 'monogram' }>
  | Readonly<{ kind: 'home' | 'box' }>
  | Readonly<{ kind: 'emoji'; value: string }>

/**
 * A workspace's mark: its chosen emoji or a box on a tile painted with the
 * workspace's own accent, so a collapsed workspace stays recognisable while
 * another workspace themes the app.
 */
export function WorkspaceIdentityMark(props: {
  accent: string | null
  logo: WorkspaceIdentityLogo
  name: string
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
}) {
  const theme = useOptionalTheme()
  const [host, setHost] = createSignal<HTMLSpanElement>()
  createEffect(() => {
    const element = host()
    if (!element) return
    if (props.accent !== null) {
      paintWorkspaceAccent(element, props.accent, theme?.variantId() ?? '')
      return
    }
    // No accent of its own: show the appearance accent, never the accent the
    // active workspace paints over the app. Read after the provider has
    // applied the current appearance to the document.
    void theme?.variantId()
    void theme?.preferences().accent
    queueMicrotask(() => {
      if (props.accent === null) paintAppearanceAccent(element)
    })
  })
  return (
    <span ref={setHost} class="workspace-identity-mark">
      <Show when={props.logo} keyed>
        {(logo) => (
          <EntityIcon
            name={props.name}
            size={props.size ?? 'sm'}
            tone="primary"
            icon={
              logo.kind === 'emoji' ? (
                <span aria-hidden="true">{logo.value}</span>
              ) : logo.kind === 'home' ? (
                <House aria-hidden="true" data-workspace-icon="home" />
              ) : (
                <Box aria-hidden="true" data-workspace-icon="box" />
              )
            }
          />
        )}
      </Show>
    </span>
  )
}
