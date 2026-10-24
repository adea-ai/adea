// The mark is two images, one per appearance. It is decorative only when the
// caller says so in Booleanish terms: `aria-hidden="false"` still exposes it.
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()

const { render } = await import('solid-js/web')
const { WorkspaceLogo } = await import('@adea-ai/app-ui/components/workspace-logo')

const disposers: Array<() => void> = []

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  document.body.innerHTML = ''
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

function mark(hidden?: boolean | 'true' | 'false') {
  const container = document.createElement('div')
  document.body.appendChild(container)
  disposers.push(render(() => <WorkspaceLogo aria-hidden={hidden} class="size-9" />, container))
  return [...container.querySelectorAll('img')]
}

describe('workspace logo', () => {
  test('renders the white and black icons, one per appearance', () => {
    const [light, dark] = mark()
    expect(light?.getAttribute('src')).toBe('/brand/adea-icon-white.png')
    expect(light?.className).toContain('dark:hidden')
    expect(dark?.getAttribute('src')).toBe('/brand/adea-icon-black.png')
    expect(dark?.className).toContain('hidden dark:block')
  })

  test.each([
    [true, '', 'true'],
    ['true', '', 'true'],
    [false, 'Adea', 'false'],
    ['false', 'Adea', 'false'],
    [undefined, 'Adea', null],
  ] as const)('aria-hidden=%p gives alt %p', (hidden, alt, ariaHidden) => {
    const images = mark(hidden)
    expect(images).toHaveLength(2)
    for (const image of images) {
      expect(image.getAttribute('alt')).toBe(alt)
      expect(image.getAttribute('aria-hidden')).toBe(ariaHidden)
    }
  })
})
