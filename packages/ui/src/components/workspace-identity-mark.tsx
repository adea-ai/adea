import { EntityIcon } from '@adea-ai/ui/components/ui/entity-icon'
import { createEffect, createSignal } from 'solid-js'

import { useOptionalTheme } from './theme-provider'
import { paintWorkspaceAccent } from './workspace-accent'

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
    if (element) paintWorkspaceAccent(element, props.accent, theme?.variantId() ?? '')
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
