import { useOptionalTheme } from '@adea-ai/ui/components/theme/lazy'
import { EntityIcon } from '@adea-ai/ui/components/ui/entity-icon'
import { resolveShellIcon } from '@adea-ai/ui/components/composites/icon-picker'
import { createEffect, createSignal } from 'solid-js'
import { Box, House } from 'lucide-solid'

import { paintAppearanceAccent, paintWorkspaceAccent } from './workspace-accent'

export type WorkspaceIdentityLogo =
  | Readonly<{ kind: 'monogram' }>
  | Readonly<{ kind: 'home' | 'box' }>
  | Readonly<{ kind: 'emoji' | 'icon' | 'image'; value: string }>

/**
 * A workspace's mark: its chosen emoji, curated icon or uploaded image, or the
 * default Home/box icon, on a tile painted with the workspace's own accent, so
 * a workspace stays recognisable while another workspace themes the app. An
 * unknown icon key draws the default box rather than an empty tile.
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
      paintWorkspaceAccent(element, props.accent, theme)
      return
    }
    // No accent of its own: show the appearance accent, never the accent the
    // active workspace paints over the app. Read after the provider has
    // applied the current appearance to the document.
    void theme?.variant().id
    void theme?.selection().accent
    queueMicrotask(() => {
      if (props.accent === null) paintAppearanceAccent(element)
    })
  })
  return (
    <span ref={setHost} class="workspace-identity-mark">
      <EntityIcon
        name={props.name}
        size={props.size ?? 'sm'}
        tone="primary"
        data-workspace-icon={
          props.logo.kind === 'emoji' || props.logo.kind === 'image'
            ? undefined
            : props.logo.kind === 'icon'
              ? props.logo.value
              : props.logo.kind === 'home'
                ? 'home'
                : 'box'
        }
        src={props.logo.kind === 'image' ? props.logo.value : undefined}
        icon={
          props.logo.kind === 'emoji' ? (
            <span aria-hidden="true">{props.logo.value}</span>
          ) : props.logo.kind === 'icon' ? (
            resolveShellIcon(props.logo.value, 'box')
          ) : props.logo.kind === 'home' ? (
            House
          ) : (
            Box
          )
        }
      />
    </span>
  )
}
