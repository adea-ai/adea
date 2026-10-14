// Lazy xterm addons (issue #396): the WebGL renderer and the search addon load
// after the base terminal is usable. These pin the races a deferred import
// introduces: output while loading, a failed import, context loss after load,
// an unmount mid-download, and rapid search open/type/close.
import { describe, expect, test } from 'bun:test'
import type { ITerminalAddon } from '@xterm/xterm'

import {
  attachLazyWebgl,
  createLazySearch,
  type SearchAddonLike,
  type WebglAddonLike,
} from '../src/terminal/lazy-addons'
import { createRendererPolicy } from '../src/terminal/renderer-policy'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function fakeTerminal() {
  const loaded: ITerminalAddon[] = []
  return { loaded, loadAddon: (addon: ITerminalAddon) => void loaded.push(addon) }
}

class FakeWebgl implements WebglAddonLike {
  static instances: FakeWebgl[] = []
  static failActivate = false
  disposed = false
  lossListeners: Array<() => void> = []
  constructor() {
    FakeWebgl.instances.push(this)
  }
  onContextLoss = ((listener: () => void) => {
    this.lossListeners.push(listener)
    return { dispose: () => undefined }
  }) as WebglAddonLike['onContextLoss']
  activate(): void {
    if (FakeWebgl.failActivate) throw new Error('WebGL2 not supported')
  }
  dispose(): void {
    this.disposed = true
  }
  loseContext(): void {
    for (const listener of this.lossListeners) listener()
  }
}

/** A terminal whose loadAddon activates the addon, like xterm's. */
function activatingTerminal() {
  const loaded: ITerminalAddon[] = []
  return {
    loaded,
    loadAddon(addon: ITerminalAddon) {
      loaded.push(addon)
      addon.activate(undefined as never)
    },
  }
}

function webglHarness() {
  FakeWebgl.instances = []
  FakeWebgl.failActivate = false
  const policy = createRendererPolicy(2)
  let disposed = false
  let changes = 0
  const terminal = activatingTerminal()
  const gate = deferred<{ WebglAddon: new () => WebglAddonLike }>()
  const attached = attachLazyWebgl({
    terminal,
    policy,
    load: () => gate.promise,
    isDisposed: () => disposed,
    onPolicyChange: () => void (changes += 1),
  })
  return {
    policy,
    terminal,
    gate,
    attached,
    changes: () => changes,
    dispose: () => void (disposed = true),
  }
}

describe('lazy WebGL', () => {
  test('stays on DOM while the chunk downloads, then reports WebGL once active', async () => {
    const h = webglHarness()
    expect(h.policy.snapshot().active).toBe('dom')
    expect(h.terminal.loaded).toHaveLength(0)
    h.gate.resolve({ WebglAddon: FakeWebgl })
    await h.attached
    expect(h.policy.snapshot().active).toBe('webgl')
    expect(h.terminal.loaded).toHaveLength(1)
    expect(h.changes()).toBe(1)
  })

  test('a failed import leaves a working DOM terminal and disables WebGL', async () => {
    const h = webglHarness()
    h.gate.reject(new Error('chunk 404'))
    await h.attached
    expect(h.policy.snapshot()).toMatchObject({ active: 'dom', webglDisabled: true })
    expect(h.terminal.loaded).toHaveLength(0)
    expect(h.changes()).toBe(1)
  })

  test('an addon that cannot activate falls back to DOM', async () => {
    const h = webglHarness()
    FakeWebgl.failActivate = true
    h.gate.resolve({ WebglAddon: FakeWebgl })
    await h.attached
    expect(h.policy.snapshot()).toMatchObject({ active: 'dom', webglDisabled: true })
  })

  test('unmounting during the download never constructs or attaches an addon', async () => {
    const h = webglHarness()
    h.dispose()
    h.gate.resolve({ WebglAddon: FakeWebgl })
    await h.attached
    expect(FakeWebgl.instances).toHaveLength(0)
    expect(h.terminal.loaded).toHaveLength(0)
    expect(h.policy.snapshot().active).toBe('dom')
    // Nothing to report on a pane that no longer exists.
    expect(h.changes()).toBe(0)
  })

  test('a failed import after unmount does not touch the disposed pane', async () => {
    const h = webglHarness()
    h.dispose()
    h.gate.reject(new Error('offline'))
    await h.attached
    expect(h.changes()).toBe(0)
  })

  test('context loss recovers on a fresh addon that is itself watched, then stays on DOM', async () => {
    const h = webglHarness()
    h.gate.resolve({ WebglAddon: FakeWebgl })
    await h.attached
    const first = FakeWebgl.instances[0]!
    first.loseContext()
    expect(first.disposed).toBe(true)
    expect(FakeWebgl.instances).toHaveLength(2)
    expect(h.policy.snapshot().active).toBe('webgl')
    // The recovered addon carries its own listener: a second loss is handled.
    const second = FakeWebgl.instances[1]!
    expect(second.lossListeners).toHaveLength(1)
    second.loseContext()
    expect(FakeWebgl.instances).toHaveLength(3)
    // The third loss exhausts the budget and DOM stays.
    FakeWebgl.instances[2]!.loseContext()
    expect(FakeWebgl.instances).toHaveLength(3)
    expect(h.policy.snapshot()).toMatchObject({ active: 'dom', webglDisabled: true })
  })

  test('context loss after unmount does not recreate the renderer', async () => {
    const h = webglHarness()
    h.gate.resolve({ WebglAddon: FakeWebgl })
    await h.attached
    h.dispose()
    FakeWebgl.instances[0]!.loseContext()
    expect(FakeWebgl.instances).toHaveLength(1)
  })

  test('a recovery that cannot activate stays on DOM without disabling the budget', async () => {
    const h = webglHarness()
    h.gate.resolve({ WebglAddon: FakeWebgl })
    await h.attached
    FakeWebgl.failActivate = true
    FakeWebgl.instances[0]!.loseContext()
    expect(h.policy.snapshot()).toMatchObject({ active: 'dom', contextLosses: 1 })
  })
})

type Find = { op: 'next' | 'previous'; query: string; caseSensitive: boolean | undefined }

class FakeSearch implements SearchAddonLike {
  finds: Find[] = []
  clears = 0
  resultListeners: Array<(results: { resultIndex: number; resultCount: number }) => void> = []
  activate(): void {}
  dispose(): void {}
  findNext = ((query: string, options?: { caseSensitive?: boolean }) => {
    this.finds.push({ op: 'next', query, caseSensitive: options?.caseSensitive })
    return true
  }) as SearchAddonLike['findNext']
  findPrevious = ((query: string, options?: { caseSensitive?: boolean }) => {
    this.finds.push({ op: 'previous', query, caseSensitive: options?.caseSensitive })
    return true
  }) as SearchAddonLike['findPrevious']
  clearDecorations(): void {
    this.clears += 1
  }
  onDidChangeResults = ((listener: (results: never) => void) => {
    this.resultListeners.push(listener as never)
    return { dispose: () => undefined }
  }) as SearchAddonLike['onDidChangeResults']
}

// Lets the controller's async load continuation run.
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function searchHarness() {
  const terminal = fakeTerminal()
  const addon = new FakeSearch()
  let gate = deferred<SearchAddonLike>()
  let loads = 0
  let disposed = false
  const results: Array<{ resultIndex: number; resultCount: number }> = []
  let unavailable = 0
  const search = createLazySearch({
    terminal,
    load: () => {
      loads += 1
      return gate.promise
    },
    isDisposed: () => disposed,
    decorations: () => undefined,
    onResults: (r) => void results.push(r),
    onUnavailable: () => void (unavailable += 1),
  })
  return {
    terminal,
    addon,
    search,
    results,
    loads: () => loads,
    unavailable: () => unavailable,
    dispose: () => void (disposed = true),
    nextGate: () => (gate = deferred<SearchAddonLike>()),
    gate: () => gate,
  }
}

const open = (query: string, caseSensitive = false) => ({ open: true, query, caseSensitive })
const closed = (query = '') => ({ open: false, query, caseSensitive: false })

describe('lazy search', () => {
  test('the addon is not fetched until search opens', async () => {
    const h = searchHarness()
    h.search.update(closed())
    await settle()
    expect(h.loads()).toBe(0)
    expect(h.search.current()).toBeUndefined()
  })

  test('rapid open, type and close applies nothing once the chunk lands', async () => {
    const h = searchHarness()
    h.search.update(open(''))
    h.search.update(open('n'))
    h.search.update(open('ne'))
    h.search.update(open('nee'))
    h.search.update(closed('nee'))
    expect(h.loads()).toBe(1)
    h.gate().resolve(h.addon)
    await settle()
    expect(h.search.current()).toBe(h.addon)
    // No stale finds for the abandoned keystrokes, and no decorations to clear.
    expect(h.addon.finds).toEqual([])
    expect(h.addon.clears).toBe(0)
  })

  test('typing while the chunk loads searches only the latest query when it lands', async () => {
    const h = searchHarness()
    h.search.update(open('a'))
    h.search.update(open('ab'))
    h.search.update(open('abc', true))
    h.gate().resolve(h.addon)
    await settle()
    expect(h.addon.finds).toEqual([{ op: 'next', query: 'abc', caseSensitive: true }])
    expect(h.terminal.loaded).toEqual([h.addon])
  })

  test('typing, closing, then reopening before the chunk lands searches the reopened query', async () => {
    const h = searchHarness()
    h.search.update(open('first'))
    h.search.update(closed('first'))
    h.search.update(open('second'))
    expect(h.loads()).toBe(1)
    h.gate().resolve(h.addon)
    await settle()
    expect(h.addon.finds.map((find) => find.query)).toEqual(['second'])
  })

  test('after load, the same inputs do not refind and closing clears decorations once', async () => {
    const h = searchHarness()
    h.search.update(open('x'))
    h.gate().resolve(h.addon)
    await settle()
    h.search.update(open('x'))
    expect(h.addon.finds).toHaveLength(1)
    h.search.update(closed('x'))
    h.search.update(closed('x'))
    expect(h.addon.clears).toBe(1)
    h.search.update(open('x'))
    expect(h.addon.finds).toHaveLength(2)
    expect(h.loads()).toBe(1)
  })

  test('result events reach the pane once the addon is attached', async () => {
    const h = searchHarness()
    h.search.update(open('x'))
    h.gate().resolve(h.addon)
    await settle()
    h.addon.resultListeners[0]!({ resultIndex: 0, resultCount: 3 })
    expect(h.results).toEqual([{ resultIndex: 0, resultCount: 3 }])
  })

  test('a failed import reports unavailable and the next open retries the import', async () => {
    const h = searchHarness()
    h.search.update(open('x'))
    h.gate().reject(new Error('chunk 404'))
    await settle()
    expect(h.unavailable()).toBe(1)
    expect(h.search.current()).toBeUndefined()
    // The terminal itself is untouched; a later keystroke retries.
    h.nextGate()
    h.search.update(open('xy'))
    expect(h.loads()).toBe(2)
    h.gate().resolve(h.addon)
    await settle()
    expect(h.addon.finds).toEqual([{ op: 'next', query: 'xy', caseSensitive: false }])
    expect(h.unavailable()).toBe(1)
  })

  test('a failure after the user closed search stays quiet', async () => {
    const h = searchHarness()
    h.search.update(open('x'))
    h.search.update(closed('x'))
    h.gate().reject(new Error('offline'))
    await settle()
    expect(h.unavailable()).toBe(0)
  })

  test('unmounting during the download never attaches to the disposed terminal', async () => {
    const h = searchHarness()
    h.search.update(open('x'))
    h.dispose()
    h.gate().resolve(h.addon)
    await settle()
    expect(h.terminal.loaded).toHaveLength(0)
    expect(h.addon.finds).toEqual([])
    expect(h.search.current()).toBeUndefined()
    expect(h.unavailable()).toBe(0)
  })

  test('a failed import after unmount reports nothing', async () => {
    const h = searchHarness()
    h.search.update(open('x'))
    h.dispose()
    h.gate().reject(new Error('offline'))
    await settle()
    expect(h.unavailable()).toBe(0)
  })
})
