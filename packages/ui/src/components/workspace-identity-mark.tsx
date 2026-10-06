import { EntityIcon } from '@adea-ai/ui/components/ui/entity-icon'
import { createEffect, createSignal } from 'solid-js'

import { useOptionalTheme } from './theme-provider'
import { paintAppearanceAccent, paintWorkspaceAccent } from './workspace-accent'

export type WorkspaceIdentityLogo =
  | Readonly<{ kind: 'monogram' }>
  | Readonly<{ kind: 'emoji'; value: string }>

/**
 * A workspace's mark: its emoji or name initials on a tile painted with the
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
  const emoji = () => (props.logo.kind === 'emoji' ? props.logo.value : undefined)
  return (
    <span ref={setHost} class="workspace-identity-mark">
      <EntityIcon
        name={props.name}
        size={props.size ?? 'sm'}
        tone="primary"
        icon={emoji() ? <span aria-hidden="true">{emoji()}</span> : undefined}
      />
    </span>
  )
}
