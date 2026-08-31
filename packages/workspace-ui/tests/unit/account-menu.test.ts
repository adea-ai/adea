import { describe, expect, test } from 'bun:test'

import { accountMenuItems, accountSessionItem } from '../../src/account-menu-model'

describe('account menu contract', () => {
  test('keeps the account menu order and disables unavailable destinations', () => {
    expect(accountMenuItems.map(({ id }) => id)).toEqual([
      'mobile',
      'about',
      'help',
      'feedback',
      'settings',
    ])
    expect(accountMenuItems.filter(({ disabled }) => disabled).map(({ id }) => id)).toEqual([
      'mobile',
      'help',
      'feedback',
    ])
    expect(accountMenuItems.filter(({ disabled }) => !disabled).map(({ id }) => id)).toEqual([
      'about',
      'settings',
    ])
  })

  test('uses the current session action at the bottom of the menu', () => {
    expect(accountSessionItem(false)).toEqual({ id: 'sign-in', label: 'Sign in', disabled: false })
    expect(accountSessionItem(true)).toEqual({ id: 'sign-out', label: 'Sign out', disabled: false })
  })
})
