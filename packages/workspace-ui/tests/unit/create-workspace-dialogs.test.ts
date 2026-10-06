import { describe, expect, test } from 'bun:test'

import {
  projectFormInputFromForm,
  projectIconKeySuggestions,
} from '../../src/create-workspace-dialogs'

describe('Project icon key suggestions', () => {
  test('submits a custom icon key even when it is not a suggestion', () => {
    const customIconKey = 'my-custom-space'
    expect(projectIconKeySuggestions).not.toContain(customIconKey)

    const form = new FormData()
    form.set('iconKey', customIconKey)
    form.set('name', 'Custom Space')

    expect(projectFormInputFromForm(form)).toEqual({
      iconKey: customIconKey,
      name: 'Custom Space',
    })
  })
})
