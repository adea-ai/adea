import { describe, expect, test } from 'bun:test'

import {
  roomFormInputFromForm,
  roomFunctionKeySuggestions,
} from '../../src/create-workspace-dialogs'

describe('Room function key suggestions', () => {
  test('submits a custom function key even when it is not a suggestion', () => {
    const customFunctionKey = 'my-custom-space'
    expect(roomFunctionKeySuggestions).not.toContain(customFunctionKey)

    const form = new FormData()
    form.set('functionKey', customFunctionKey)
    form.set('name', 'Custom Space')

    expect(roomFormInputFromForm(form)).toEqual({
      functionKey: customFunctionKey,
      name: 'Custom Space',
    })
  })
})
