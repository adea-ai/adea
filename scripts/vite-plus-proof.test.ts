import { describe, expect, test } from 'bun:test'

import { matchesPattern, parseVpOutput } from './vite-plus-proof.mjs'

const miss =
  "$ ORCH_TOOLCHAIN=linux-x64.node22.bun1.4.0-abc env -u FORCE_COLOR bun run --cwd packages/types build ○ cache miss: env 'ORCH_TOOLCHAIN' changed, executing"

describe('parseVpOutput', () => {
  test('reads the summary, the misses and the toolchain id', () => {
    const result = parseVpOutput(`${miss}\n\n---\nvp run: 14/15 cache hit (93%), 17/17 successful`)
    expect(result.hits).toBe(14)
    expect(result.total).toBe(15)
    expect(result.toolchain).toBe('linux-x64.node22.bun1.4.0-abc')
    expect(result.missed).toEqual([
      { command: 'bun run --cwd packages/types build', reason: "env 'ORCH_TOOLCHAIN' changed" },
    ])
  })

  test('refuses output with no cache summary', () => {
    expect(() => parseVpOutput('nothing here')).toThrow('printed no cache summary')
  })
})

describe('matchesPattern', () => {
  test('cold allows no hit and warm needs every task to hit', () => {
    expect(matchesPattern({ hits: 0, total: 15, missed: [], toolchain: null }, 'cold')).toBe(true)
    expect(matchesPattern({ hits: 1, total: 15, missed: [], toolchain: null }, 'cold')).toBe(false)
    expect(matchesPattern({ hits: 15, total: 15, missed: [], toolchain: null }, 'warm')).toBe(true)
    expect(matchesPattern({ hits: 14, total: 15, missed: [], toolchain: null }, 'warm')).toBe(false)
  })

  test('an empty graph is neither cold nor warm', () => {
    expect(matchesPattern({ hits: 0, total: 0, missed: [], toolchain: null }, 'cold')).toBe(false)
    expect(matchesPattern({ hits: 0, total: 0, missed: [], toolchain: null }, 'warm')).toBe(false)
  })
})
