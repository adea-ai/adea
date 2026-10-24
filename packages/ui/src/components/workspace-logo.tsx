import type { ComponentProps } from 'solid-js'

import { appIconSrc } from '../lib/app-icon'

type WorkspaceLogoProps = Pick<ComponentProps<'img'>, 'class' | 'aria-hidden'> & {
  role?: 'img' | 'presentation'
}

/**
 * The canonical Adea mark used by web, desktop, and dialogs. It is the white
 * app icon in light appearance and the black one in dark appearance; the
 * user's Dock icon pick never changes it.
 */
export function WorkspaceLogo(props: WorkspaceLogoProps) {
  const alt = () => (props['aria-hidden'] ? '' : 'Adea')
  return (
    <>
      <img
        src={appIconSrc('white')}
        alt={alt()}
        role={props.role}
        aria-hidden={props['aria-hidden']}
        class={`${props.class ?? ''} dark:hidden`}
        draggable={false}
      />
      <img
        src={appIconSrc('black')}
        alt={alt()}
        role={props.role}
        aria-hidden={props['aria-hidden']}
        class={`${props.class ?? ''} hidden dark:block`}
        draggable={false}
      />
    </>
  )
}
