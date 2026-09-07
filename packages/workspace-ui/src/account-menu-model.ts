export const accountMenuItems = [
  { id: 'mobile', label: 'Get Adea mobile', disabled: true },
  { id: 'about', label: 'About', disabled: false },
  { id: 'help', label: 'Help Center', disabled: true },
  { id: 'feedback', label: 'Send Feedback', disabled: true },
  { id: 'updates', label: 'Updates', disabled: false, desktopOnly: true },
  { id: 'settings', label: 'Settings', disabled: false },
] as const

export type AccountMenuItemId = (typeof accountMenuItems)[number]['id']

export type AccountMenuPlatform = 'desktop' | 'web'

export function accountMenuItemsForPlatform(platform: AccountMenuPlatform) {
  return accountMenuItems.filter(
    (item) => !('desktopOnly' in item && item.desktopOnly) || platform === 'desktop'
  )
}

export function accountSessionItem(authenticated: boolean) {
  return {
    id: authenticated ? ('sign-out' as const) : ('sign-in' as const),
    label: authenticated ? 'Sign out' : 'Sign in',
    disabled: false,
  }
}
