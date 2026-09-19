// Ported donor tests: Orca `retired-name-registry.test.ts` +
// `worktree-name-suggestion` fixtures, pinned revision
// 403b62a8d8fa6e896a93acc4c15405be0f0b7dc7 (MIT), translated to bun:test and
// the Adea module names. Proven behavior preserved: tier parsing, watermark
// compaction, out-of-order tier completion, and the never-reuse guarantee.
import { describe, expect, test } from 'bun:test'

import { WORKTREE_NAME_POOL } from '../shell/src/dev-runtime/worktrees/name-pool'
import {
  addRetiredNames,
  clampExhaustedTiers,
  compactRetiredNames,
  createRetiredNameLookup,
  EMPTY_RETIRED_NAME_REGISTRY,
  mergeRetiredNameRegistries,
  selectWorktreeName,
  worktreeNameTier,
} from '../shell/src/dev-runtime/worktrees/retired-names'

const POOL = WORKTREE_NAME_POOL.map((name) => name.toLowerCase())
const tier = (n: number) => POOL.map((name) => (n === 1 ? name : `${name}-${n}`))

describe('worktreeNameTier', () => {
  test.each([
    ['nautilus', 1],
    ['Nautilus', 1],
    ['  nautilus  ', 1],
    ['nautilus-2', 2],
    ['nautilus-10', 10],
    ['nautilus-999999', 999999],
  ])('reads %s as tier %s', (name, expected) => {
    expect(worktreeNameTier(name)).toBe(expected)
  })

  test.each([
    // A user-typed name must never be covered by a watermark, or a spent tier
    // would silently retire names the pool has no claim on.
    'fix-login-2',
    'fix-login',
    // The suggester never emits these, so no tier can ever complete for them.
    'nautilus-2-3',
    'nautilus-1',
    'nautilus-0',
    'nautilus-02',
    'nautilus-1000000',
  ])('leaves %s outside every tier', (name) => {
    expect(worktreeNameTier(name)).toBeNull()
  })
})

describe('compactRetiredNames', () => {
  test('does not move the watermark while one name of the tier is missing', () => {
    const registry = compactRetiredNames({ exhaustedTiers: 0, names: POOL.slice(0, -1) })
    expect(registry.exhaustedTiers).toBe(0)
    expect(registry.names.length).toBe(POOL.length - 1)
  })

  test('folds a completed tier into the watermark and drops its names', () => {
    expect(compactRetiredNames({ exhaustedTiers: 0, names: tier(1) })).toEqual({
      exhaustedTiers: 1,
      names: [],
    })
  })

  test('rolls through consecutive tiers that completed out of order', () => {
    const registry = compactRetiredNames({
      exhaustedTiers: 0,
      names: [...tier(3), ...tier(2), ...tier(1)],
    })
    expect(registry).toEqual({ exhaustedTiers: 3, names: [] })
  })

  test('stops at the first incomplete tier and keeps everything above it', () => {
    const registry = compactRetiredNames({
      exhaustedTiers: 0,
      names: [...tier(1), 'nautilus-3', 'nautilus-2-3'],
    })
    expect(registry.exhaustedTiers).toBe(1)
    expect(registry.names.toSorted()).toEqual(['nautilus-2-3', 'nautilus-3'])
  })

  test('drops names a higher watermark already covers', () => {
    expect(
      compactRetiredNames({ exhaustedTiers: 2, names: ['nautilus', 'orca-2', 'orca-3'] })
    ).toEqual({
      exhaustedTiers: 2,
      names: ['orca-3'],
    })
  })

  test.each([
    ['a negative watermark', -1],
    ['a fractional watermark', 1.5],
    ['a non-number watermark', 'many'],
    ['no watermark', undefined],
  ])('clamps %s to none rather than trusting it', (_label, value) => {
    expect(clampExhaustedTiers(value)).toBe(0)
    expect(compactRetiredNames({ exhaustedTiers: value as number, names: [] }).exhaustedTiers).toBe(
      0
    )
  })
})

describe('createRetiredNameLookup', () => {
  test('reports a compacted tier as retired without listing its names', () => {
    const lookup = createRetiredNameLookup({ exhaustedTiers: 2, names: [] })
    expect(POOL.every((name) => lookup(name))).toBe(true)
    expect(POOL.every((name) => lookup(`${name}-2`))).toBe(true)
    expect(lookup('nautilus-3')).toBe(false)
  })

  test('does not retire a user-typed name that merely ends in a spent tier number', () => {
    expect(createRetiredNameLookup({ exhaustedTiers: 5, names: [] })('fix-login-2')).toBe(false)
  })

  test('still answers for explicit names above the watermark', () => {
    const lookup = createRetiredNameLookup({ exhaustedTiers: 1, names: ['nautilus-3'] })
    expect(lookup('NAUTILUS-3')).toBe(true)
    expect(lookup('orca-3')).toBe(false)
  })
})

describe('addRetiredNames', () => {
  test('reports no change when every name is already covered by the watermark', () => {
    expect(addRetiredNames({ exhaustedTiers: 1, names: [] }, ['nautilus'])).toBeNull()
  })

  test('compacts as soon as the added name completes the tier', () => {
    const before = { exhaustedTiers: 0, names: POOL.slice(0, -1) }
    expect(addRetiredNames(before, [POOL.at(-1) as string])).toEqual({
      exhaustedTiers: 1,
      names: [],
    })
  })

  test('keeps an out-of-order higher-tier name through a lower tier compacting', () => {
    const before = { exhaustedTiers: 0, names: [...POOL.slice(0, -1), 'nautilus-2'] }
    expect(addRetiredNames(before, [POOL.at(-1) as string])).toEqual({
      exhaustedTiers: 1,
      names: ['nautilus-2'],
    })
  })
})

describe('mergeRetiredNameRegistries', () => {
  test('takes the higher watermark and drops what it covers', () => {
    expect(
      mergeRetiredNameRegistries(
        { exhaustedTiers: 2, names: ['nautilus-3'] },
        { exhaustedTiers: 0, names: ['nautilus', 'orca-2', 'seahorse-4'] }
      )
    ).toEqual({ exhaustedTiers: 2, names: ['nautilus-3', 'seahorse-4'] })
  })

  test('completes a tier out of two partial peers', () => {
    const half = Math.floor(POOL.length / 2)
    expect(
      mergeRetiredNameRegistries(
        { exhaustedTiers: 0, names: POOL.slice(0, half) },
        { exhaustedTiers: 0, names: POOL.slice(half) }
      )
    ).toEqual({ exhaustedTiers: 1, names: [] })
  })
})

const pickFirst = () => 0

describe('end-to-end retirement guarantee', () => {
  test('never suggests a name that has been retired, compacted or not', () => {
    let registry = EMPTY_RETIRED_NAME_REGISTRY
    const issued: string[] = []
    // Two full tiers plus one, so the run crosses compaction twice and lands
    // above the watermark.
    for (let index = 0; index < POOL.length * 2 + 1; index += 1) {
      const name = selectWorktreeName(registry.names, pickFirst, registry.exhaustedTiers)
      expect(issued).not.toContain(name)
      issued.push(name)
      registry = addRetiredNames(registry, [name]) ?? registry
    }

    expect(new Set(issued).size).toBe(issued.length)
    expect(registry).toEqual({ exhaustedTiers: 2, names: [`${POOL[0]}-3`] })
    const isRetired = createRetiredNameLookup(registry)
    expect(issued.every((name) => isRetired(name))).toBe(true)
  })
})
