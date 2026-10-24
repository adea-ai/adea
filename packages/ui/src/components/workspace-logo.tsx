import type { ComponentProps } from 'solid-js'

import { appIconSrc } from '../lib/app-icon'

type WorkspaceLogoProps = Pick<ComponentProps<'img'>, 'class' | 'aria-hidden'>

/**
 * The canonical Adea mark used by web, desktop, and dialogs. It is the white
 * app icon in light appearance and the black one in dark appearance; the
 * user's Dock icon pick never changes it.
 */
export function WorkspaceLogo(props: WorkspaceLogoProps) {
  const decorative = () => props['aria-hidden'] === true || props['aria-hidden'] === 'true'
  return (
    <>
      <img
        src={appIconSrc('white')}
        alt={decorative() ? '' : 'Adea'}
        aria-hidden={props['aria-hidden']}
        class={`${props.class ?? ''} dark:hidden`}
        draggable={false}
      />
      <img
        src={appIconSrc('black')}
        alt={decorative() ? '' : 'Adea'}
        aria-hidden={props['aria-hidden']}
        class={`${props.class ?? ''} hidden dark:block`}
        draggable={false}
      />
    </>
  )
}
