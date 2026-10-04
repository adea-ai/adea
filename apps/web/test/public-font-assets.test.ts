import { expect, test } from 'bun:test'
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { publicFontAssetDirectories } from '../start/public-font-assets'

test('linked UI fonts expose readable public assets through narrowly scoped real directories', () => {
  const directories = publicFontAssetDirectories()
  expect(new Set(directories).size).toBe(4)
  for (const directory of directories) {
    expect(directory).toBe(realpathSync(directory))
    expect(directory).toMatch(/[/\\]@fontsource-variable[/\\][a-z-]+[/\\]files$/)
    const fonts = readdirSync(directory).filter((file) => file.endsWith('.woff2'))
    expect(fonts.length).toBeGreaterThan(0)
    expect(readFileSync(join(directory, fonts[0])).subarray(0, 4).toString()).toBe('wOF2')
  }
})
