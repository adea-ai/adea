// The Settings row for the Dock icon, exercised as a user would. A pick only counts once it is
// persisted: a failed save keeps its error, never asks the shell to change the icon, and never
// reads as saved. The DOM is registered before the components load because Solid's browser build
// decides what it is when it is imported.
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()

const { render } = await import('solid-js/web')
const { AppIconSetting } = await import('../../src/app-icon-picker')

type Variant = 'white' | 'violet' | 'black'

const disposers: Array<() => void> = []

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  document.body.innerHTML = ''
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`the row never showed ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function mount(options: { save(variant: Variant): Promise<boolean>; applied?: boolean }) {
  const applies: Variant[] = []
  const container = document.createElement('div')
  document.body.appendChild(container)
  disposers.push(
    render(
      () => (
        <AppIconSetting
          value="white"
          save={options.save}
          apply={async (variant) => {
            applies.push(variant)
            return options.applied ?? false
          }}
        />
      ),
      container
    )
  )
  const pick = (variant: Variant) => {
    const radio = container.querySelector<HTMLInputElement>(
      `input[type="radio"][value="${variant}"]`
    )
    if (!radio) throw new Error(`no ${variant} option`)
    radio.click()
  }
  return { container, applies, pick }
}

describe('app icon setting', () => {
  test('a failed save keeps its error, skips the native apply, and never reads as saved', async () => {
    const { container, applies, pick } = mount({ save: async () => false })
    pick('violet')
    await waitFor(() => container.querySelector('[role="alert"]') !== null, 'the save error')
    expect(container.textContent).toContain('could not be saved')
    expect(container.textContent).not.toContain('Saved')
    expect(applies).toEqual([])
  })

  test('a save that rejects is treated the same as one that reports failure', async () => {
    const { container, applies, pick } = mount({
      save: () => Promise.reject(new Error('disk full')),
    })
    pick('black')
    await waitFor(() => container.querySelector('[role="alert"]') !== null, 'the save error')
    expect(container.textContent).not.toContain('Saved')
    expect(applies).toEqual([])
  })

  test('a persisted pick is applied, and says so only when the shell cannot change the icon', async () => {
    const kept = mount({ save: async () => true, applied: false })
    kept.pick('violet')
    await waitFor(() => (kept.container.textContent ?? '').includes('Saved.'), 'the saved note')
    expect(kept.applies).toEqual(['violet'])
    expect(kept.container.querySelector('[role="alert"]')).toBeNull()

    const applied = mount({ save: async () => true, applied: true })
    applied.pick('black')
    await waitFor(() => applied.applies.length === 1, 'the native apply')
    expect(applied.applies).toEqual(['black'])
    expect(applied.container.textContent).not.toContain('Saved.')
    expect(applied.container.querySelector('[role="alert"]')).toBeNull()
  })
})
