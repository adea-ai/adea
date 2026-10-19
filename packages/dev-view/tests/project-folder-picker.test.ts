/*
 * The host's native folder picker, composed.
 *
 * The picker is the desktop app's OS boundary: the shell opens a native panel
 * and answers with one absolute path, with `null` when the user cancelled, or
 * by rejecting when the shell cannot open a panel at all. The picker only
 * fills the field — the path still goes through the Dev Runtime's
 * `dev.project.authorizeRoot` — so the rules that matter are about the field
 * and about the request itself:
 *
 * - a cancelled or failed pick leaves the typed path untouched, so the typed
 *   input stays the fallback;
 * - a completion that arrives after the form was torn down (a navigation, or
 *   the component unmounting) changes nothing;
 * - a repeated request while a pick is in flight asks the host once.
 *
 * The OS boundary is mocked: the host is the `pickFolder` contract the Dev
 * sidebar and the detailed project dialog pass in. No native panel, no keychain,
 * no browser and no account are involved.
 */
import { describe, expect, test } from 'bun:test'
import { createRoot } from 'solid-js'

import {
  createProjectFolderPicker,
  type ProjectFolderPicker,
} from '../src/sidebar/project-folder-picker'

const tick = () => new Promise<void>((done) => setTimeout(done, 0))

/** A host picker that answers with the given value once it is released. */
function deferredPicker<T>() {
  let release: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => {
    release = resolve
  })
  return {
    promise,
    release: (value: T) => release?.(value),
  }
}

describe('the composed project folder picker', () => {
  test('a picked folder fills the path', async () => {
    await createRoot(async (dispose) => {
      const picker = createProjectFolderPicker({
        pickFolder: () => Promise.resolve('/Users/me/Developer/project'),
      })
      try {
        await picker.choose()
        expect(picker.path()).toBe('/Users/me/Developer/project')
        expect(picker.picking()).toBe(false)
      } finally {
        dispose()
      }
    })
  })

  test('a cancelled pick leaves the typed path untouched', async () => {
    await createRoot(async (dispose) => {
      const picker = createProjectFolderPicker({ pickFolder: () => Promise.resolve(null) })
      try {
        picker.setPath('/Users/me/typed/project')
        await picker.choose()
        expect(picker.path()).toBe('/Users/me/typed/project')
        expect(picker.picking()).toBe(false)
      } finally {
        dispose()
      }
    })
  })

  test('a failed pick leaves the typed path untouched and never rejects', async () => {
    await createRoot(async (dispose) => {
      const picker = createProjectFolderPicker({
        pickFolder: () => Promise.reject(new Error('folder_picker_unavailable')),
      })
      try {
        picker.setPath('/Users/me/typed/project')
        await picker.choose()
        expect(picker.path()).toBe('/Users/me/typed/project')
        expect(picker.picking()).toBe(false)
      } finally {
        dispose()
      }
    })
  })

  test('a host without a picker changes nothing', async () => {
    await createRoot(async (dispose) => {
      const picker = createProjectFolderPicker({})
      try {
        picker.setPath('/Users/me/typed/project')
        await picker.choose()
        expect(picker.path()).toBe('/Users/me/typed/project')
        expect(picker.picking()).toBe(false)
      } finally {
        dispose()
      }
    })
  })

  test('a completion that arrives after the form was torn down changes nothing', async () => {
    const deferred = deferredPicker<string | null>()
    let picker: ProjectFolderPicker | undefined
    const dispose = createRoot((rootDispose) => {
      picker = createProjectFolderPicker({ pickFolder: () => deferred.promise })
      picker.setPath('/Users/me/typed/project')
      void picker.choose()
      return rootDispose
    })
    // The form is gone — a navigation, or the component unmounting — while the
    // native panel is still open.
    dispose()
    deferred.release('/Users/me/Developer/late')
    await tick()
    await tick()
    // Nothing threw, and the late path was not applied to the disposed form.
    expect(picker?.path()).toBe('/Users/me/typed/project')
  })

  test('a repeated request while a pick is in flight asks the host once', async () => {
    const deferred = deferredPicker<string | null>()
    let requests = 0
    await createRoot(async (dispose) => {
      const picker = createProjectFolderPicker({
        pickFolder: () => {
          requests += 1
          return deferred.promise
        },
      })
      try {
        const first = picker.choose()
        const second = picker.choose()
        const third = picker.choose()
        await tick()
        expect(requests).toBe(1)
        expect(picker.picking()).toBe(true)
        deferred.release('/Users/me/Developer/project')
        await Promise.all([first, second, third])
        expect(requests).toBe(1)
        expect(picker.path()).toBe('/Users/me/Developer/project')
        expect(picker.picking()).toBe(false)
      } finally {
        dispose()
      }
    })
  })

  test('a request after a finished pick asks the host again', async () => {
    let requests = 0
    await createRoot(async (dispose) => {
      const picker = createProjectFolderPicker({
        pickFolder: () => {
          requests += 1
          return Promise.resolve(`/picked/${requests}`)
        },
      })
      try {
        await picker.choose()
        await picker.choose()
        expect(requests).toBe(2)
        expect(picker.path()).toBe('/picked/2')
      } finally {
        dispose()
      }
    })
  })
})
