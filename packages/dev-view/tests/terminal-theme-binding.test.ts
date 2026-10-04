import { expect, test } from 'bun:test'
import {
  terminalThemeFromStyles,
  terminalFontFromStyles,
  createTerminalFontBinding,
} from '../src/terminal/theme-binding'

test('terminal roles map all ANSI slots without retaining an unrelated palette', () => {
  const values: Record<string, string> = {
    '--terminal-background': '#112233',
    '--terminal-foreground': '#ddeeff',
    '--terminal-cursor': '#abcdef',
    '--terminal-selection': '#445566',
  }
  const names = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']
  for (const [index, name] of names.entries()) {
    values[`--terminal-ansi-${name}`] = `#00000${index}`
    values[`--terminal-ansi-bright-${name}`] = `#11111${index}`
  }
  const theme = terminalThemeFromStyles({ getPropertyValue: (role) => values[role] ?? '' })
  expect(theme.background).toBe('#112233')
  expect(theme.foreground).toBe('#ddeeff')
  expect(theme.cursor).toBe('#abcdef')
  expect(theme.cursorAccent).toBe(theme.background)
  expect(theme.selectionBackground).toBe('#445566')
  for (const [index, name] of names.entries()) {
    expect(theme[name as keyof typeof theme]).toBe(`#00000${index}`)
    const bright = `bright${name[0]!.toUpperCase()}${name.slice(1)}`
    expect(theme[bright as keyof typeof theme]).toBe(`#11111${index}`)
  }
})

test('absent canonical tokens do not inject a competing fallback theme', () => {
  const theme = terminalThemeFromStyles({ getPropertyValue: () => ' ' })
  expect(Object.values(theme).every((value) => value === undefined)).toBe(true)
})

test('terminal typography follows the computed code surface, including text scaling', () => {
  expect(
    terminalFontFromStyles({ fontFamily: 'JetBrains Mono, monospace', fontSize: '18px' })
  ).toEqual({
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 18,
  })
  expect(
    terminalFontFromStyles({ fontFamily: 'JetBrains Mono, monospace', fontSize: '36px' })
  ).toEqual({
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 36,
  })
  expect(terminalFontFromStyles({ fontFamily: '', fontSize: '' })).toEqual({
    fontFamily: undefined,
    fontSize: undefined,
  })
})

test('terminal waits for font readiness and ignores an obsolete font completion', async () => {
  const committed: { fontFamily: string; fontSize: number }[] = []
  let finish: ((faces: FontFace[]) => void) | undefined
  const requested: string[] = []
  const binding = createTerminalFontBinding(
    {
      check: (description) =>
        description.includes('monospace') && !description.includes('JetBrains'),
      load: (description) => {
        requested.push(description)
        return new Promise<FontFace[]>((resolve) => {
          finish = resolve
        })
      },
    },
    (font) => committed.push(font)
  )
  binding.update({ fontFamily: 'monospace', fontSize: '12px' })
  expect(requested).toEqual([])
  binding.update({ fontFamily: 'JetBrains Mono, monospace', fontSize: '16px' })
  expect(committed).toEqual([{ fontFamily: 'monospace', fontSize: 12 }])
  binding.update({ fontFamily: 'JetBrains Mono, monospace', fontSize: '16px' })
  expect(requested).toHaveLength(1)
  binding.update({ fontFamily: 'monospace', fontSize: '18px' })
  finish?.([])
  await Promise.resolve()
  expect(committed).toEqual([
    { fontFamily: 'monospace', fontSize: 12 },
    { fontFamily: 'monospace', fontSize: 18 },
  ])
  binding.dispose()
})

test('terminal applies a loaded font once and never writes after disposal', async () => {
  const committed: { fontFamily: string; fontSize: number }[] = []
  const pending: ((faces: FontFace[]) => void)[] = []
  const binding = createTerminalFontBinding(
    {
      check: () => false,
      load: () => new Promise<FontFace[]>((resolve) => pending.push(resolve)),
    },
    (font) => committed.push(font)
  )
  binding.update({ fontFamily: 'JetBrains Mono, monospace', fontSize: '16px' })
  pending[0]?.([])
  await Promise.resolve()
  expect(committed).toEqual([{ fontFamily: 'JetBrains Mono, monospace', fontSize: 16 }])
  binding.update({ fontFamily: 'JetBrains Mono, monospace', fontSize: '20px' })
  binding.dispose()
  pending[1]?.([])
  await Promise.resolve()
  expect(committed).toHaveLength(1)
})

test('terminal retains the declared fallback when an optional font cannot load', async () => {
  const committed: { fontFamily: string; fontSize: number }[] = []
  const binding = createTerminalFontBinding(
    {
      check: () => false,
      load: () => Promise.reject(new Error('font unavailable')),
    },
    (font) => committed.push(font)
  )
  binding.update({ fontFamily: 'JetBrains Mono, monospace', fontSize: '16px' })
  await Promise.resolve()
  expect(committed).toEqual([{ fontFamily: 'JetBrains Mono, monospace', fontSize: 16 }])
  binding.dispose()
})
