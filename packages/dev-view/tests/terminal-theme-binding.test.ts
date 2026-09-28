import { expect, test } from 'bun:test'
import { terminalThemeFromStyles } from '../src/terminal/theme-binding'

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
