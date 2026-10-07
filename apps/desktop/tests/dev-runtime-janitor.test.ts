// Machine-wide janitor (spec "Machine-wide janitor"): the closed scan
// universe, bounded sizing, and the explicit plan/commit cleanup pair over an
// in-memory filesystem. No test touches the real filesystem: every safety
// property — nothing disposed without a plan, nothing disposed on a changed
// identity, Trash as the default disposal, single-use plans — is asserted
// exactly against scripted fixtures.
import { describe, expect, test } from 'bun:test'

import type {
  DevOperation,
  JanitorCommitResult,
  JanitorScanReport,
} from '../../../packages/types/src/dev-runtime'
import { decodeDevReply } from '../../../packages/types/src/dev-runtime'

/** Decodes a success value through the full reply envelope, the way the
 * transport does. */
function replyDecodes(operation: DevOperation, value: unknown): boolean {
  const reply = decodeDevReply({
    schemaVersion: 1,
    operation,
    requestId: '00000000-0000-4000-8000-000000000002',
    ok: true,
    value,
    observedAt: '2026-10-06T09:20:00.000Z',
  })
  return reply.ok
}
import { createJanitorAuthority } from '../shell/src/dev-runtime/resources/janitor'
import {
  janitorPathLabel,
  janitorPlanDigest,
  janitorSectionRoots,
  janitorWorktreeCandidates,
  measureBytes,
  parseWorktreePorcelain,
  trashDestinationName,
  type JanitorFs,
  type JanitorFsEntry,
} from '../shell/src/dev-runtime/resources/janitor-model'

const HOME = '/Users/dev'
const NOW = 1_700_000_000_000

type FsNode = {
  kind: 'dir' | 'file'
  identity: { device: string; inode: string }
  bytes: number
  mtimeMs: number
  children?: Map<string, FsNode>
  symlinkTo?: string
}

/** In-memory filesystem: absolute paths resolve through the '/'-split tree. */
function fixtureFs(root: Map<string, FsNode>): JanitorFs {
  function resolve(path: string): FsNode | undefined {
    if (path === '' || path === '/') return undefined
    let node: FsNode | undefined
    let current: Map<string, FsNode> | undefined = root
    for (const segment of path.split('/').filter((part) => part.length > 0)) {
      if (!current) return undefined
      node = current.get(segment)
      if (!node) return undefined
      current = node.children
    }
    return node
  }
  function entryOf(path: string): JanitorFsEntry | undefined {
    const node = resolve(path)
    if (!node) return undefined
    return {
      isDirectory: node.kind === 'dir',
      isFile: node.kind === 'file',
      isSymbolicLink: node.symlinkTo !== undefined,
      identity: node.identity,
      bytes: node.bytes,
      mtimeMs: node.mtimeMs,
    }
  }
  return {
    lstat: entryOf,
    readdir(path) {
      const node = resolve(path)
      if (!node?.children) return []
      return [...node.children.keys()]
    },
    rename(from, to) {
      const node = resolve(from)
      if (!node) throw new Error(`ENOENT: ${from}`)
      const slash = to.lastIndexOf('/')
      const parent = resolve(to.slice(0, slash))
      if (!parent?.children) throw new Error('ENOTDIR: trash root missing')
      if (parent.children.has(to.slice(slash + 1))) throw new Error('EEXIST')
      const name = to.slice(slash + 1)
      const fromSlash = from.lastIndexOf('/')
      const fromParent = resolve(from.slice(0, fromSlash))
      fromParent?.children?.delete(from.slice(fromSlash + 1))
      parent.children.set(name, node)
    },
    removeRecursive(path) {
      const node = resolve(path)
      if (!node) throw new Error(`ENOENT: ${path}`)
      const slash = path.lastIndexOf('/')
      const parent = resolve(path.slice(0, slash))
      parent?.children?.delete(path.slice(slash + 1))
    },
  }
}

function dir(children: Record<string, FsNode> = {}, mtimeMs = NOW - 5_000): FsNode {
  return {
    kind: 'dir',
    identity: {
      device: `dev-${Object.keys(children).length}-x`,
      inode: `ino-${JSON.stringify(Object.keys(children))}-x`,
    },
    bytes: 4096,
    mtimeMs,
    children: new Map(Object.entries(children)),
  }
}

function file(bytes: number, mtimeMs = NOW - 5_000): FsNode {
  return { kind: 'file', identity: { device: 'd', inode: `f${bytes}-${mtimeMs}` }, bytes, mtimeMs }
}

/** The standard fixture machine: DerivedData, Caches, Logs, Trash junk plus
 * one symlink and one stray file outside the Trash. */
function junkMachine(): Map<string, FsNode> {
  return new Map(
    Object.entries({
      Users: dir({
        dev: dir({
          Library: dir({
            Developer: dir({
              Xcode: dir({
                DerivedData: dir({
                  'MyApp-abc123': dir({
                    Build: dir({ Products: dir({ app: file(500) }) }),
                  }),
                  'OtherApp-def456': dir({ Index: dir({ store: file(250) }) }),
                  'link-not-followed': {
                    ...file(0),
                    symlinkTo: '/somewhere',
                  } as FsNode,
                }),
              }),
            }),
            Caches: dir({
              'com.apple.Safari': dir({ fsCachedData: dir({ blob: file(700) }) }),
              'stray-file.log': file(30),
            }),
            Logs: dir({ 'app-dir': dir({ 'app.log': file(120) }) }),
          }),
          '.Trash': dir({
            'old-download.zip': file(90_000),
            'moved-project': dir({ src: file(1_000) }),
          }),
        }),
      }),
    })
  )
}

const roots = janitorSectionRoots(HOME)

function authority(machine: Map<string, FsNode>, overrides: Record<string, unknown> = {}) {
  const created = createJanitorAuthority({
    scope: {
      accountId: '00000000-0000-4000-8000-000000000001',
      workspaceId: '00000000-0000-4000-8000-000000000002',
      runtimeNodeId: '00000000-0000-4000-8000-000000000003',
    },
    home: HOME,
    fs: fixtureFs(machine),
    now: () => NOW,
    randomId: (() => {
      let counter = 0
      return () => `00000000-0000-4000-8000-${String((counter += 1)).padStart(12, '0')}`
    })(),
    registeredRoots: () => [],
    scanRoots: () => [],
    ...overrides,
  })
  return created
}

async function scanned(machine: Map<string, FsNode>, overrides: Record<string, unknown> = {}) {
  const janitor = authority(machine, overrides)
  const report = await janitor.scan()
  return { janitor, report }
}

describe('janitor scan: the closed universe', () => {
  test('lists first-level junk entries with stable ids, labels, and disposals', async () => {
    const { report } = await scanned(junkMachine())
    const bySection = (section: JanitorScanReport['items'][number]['section']) =>
      report.items.filter((item) => item.section === section)
    expect(
      bySection('derived_data')
        .map((item) => item.label)
        .toSorted()
    ).toEqual(['MyApp-abc123', 'OtherApp-def456'])
    // Outside the Trash only directories are junk entries: a stray file in
    // Caches is never listed, and an app's logs are its directory.
    expect(bySection('cache').map((item) => item.label)).toEqual(['com.apple.Safari'])
    expect(bySection('logs').map((item) => item.label)).toEqual(['app-dir'])
    expect(
      bySection('trash')
        .map((item) => item.label)
        .toSorted()
    ).toEqual(['moved-project', 'old-download.zip'])
    // Disposal follows the section: junk moves to the Trash, Trash entries empty.
    expect(bySection('derived_data').every((item) => item.disposal === 'trash')).toBe(true)
    expect(bySection('trash').every((item) => item.disposal === 'trash_empty')).toBe(true)
    // Paths are home-abbreviated; the absolute path never leaves the host.
    const safari = bySection('cache').find((item) => item.label === 'com.apple.Safari')
    expect(safari?.pathLabel).toBe('~/Library/Caches/com.apple.Safari')
    expect(JSON.stringify(report)).not.toContain(HOME)
    // Ids are stable across scans.
    const again = await (await scanned(junkMachine())).janitor.scan()
    expect(again.items.map((item) => item.id).toSorted()).toEqual(
      report.items.map((item) => item.id).toSorted()
    )
  })

  test('the reply decodes through the strict janitor decoder', async () => {
    const { report } = await scanned(junkMachine())
    expect(replyDecodes('dev.resources.janitorScan', report)).toBe(true)
  })

  test('symlinks and the quarantine trash never become items', async () => {
    const machine = junkMachine()
    const derived = ((machine.get('Users') as FsNode).children as Map<string, FsNode>)
      .get('dev')!
      .children!.get('Library')!
      .children!.get('Developer')!
      .children!.get('Xcode')!
      .children!.get('DerivedData')!.children as Map<string, FsNode>
    derived.set('.adea-worktree-trash', dir({ 'wt-1-abc': dir() }))
    const { report } = await scanned(machine)
    expect(report.items.some((item) => item.label.includes('adea'))).toBe(false)
    expect(report.items.some((item) => item.label === 'link-not-followed')).toBe(false)
  })
})

describe('janitor worktree discovery', () => {
  const porcelain = [
    'worktree /Users/dev/projects/primary',
    'HEAD abc',
    'branch refs/heads/main',
    '',
    'worktree /Users/dev/elsewhere/feature',
    'branch refs/heads/feature',
    '',
    'worktree /Users/dev/elsewhere/scratch',
    'branch refs/heads/scratch',
    '',
    'worktree /Users/dev/elsewhere/pinned',
    'branch refs/heads/pinned',
    'locked',
    '',
    'worktree /Users/dev/elsewhere/stale',
    'branch refs/heads/stale',
    'prunable gitdir file points to non-existent location',
    '',
  ].join('\n')

  test('unregistered worktrees are candidates: stale prunes, healthy trashes, locked never', () => {
    const candidates = janitorWorktreeCandidates({
      entries: parseWorktreePorcelain(porcelain),
      root: '/Users/dev/projects/primary',
      registeredRoots: ['/Users/dev/elsewhere/feature'],
      home: HOME,
    })
    // The registered root and the primary checkout never appear; the locked
    // worktree is the user's own pin and never appears either.
    expect(candidates.map((candidate) => candidate.canonicalPath).toSorted()).toEqual(
      ['/Users/dev/elsewhere/stale', '/Users/dev/elsewhere/scratch'].toSorted()
    )
    const stale = candidates.find((candidate) => candidate.disposal === 'prune')
    expect(stale?.canonicalPath).toBe('/Users/dev/elsewhere/stale')
    expect(stale?.branchLabel).toBe('stale')
    expect(stale?.prunableReason).toContain('non-existent')
    expect(stale?.pathLabel).toBe('~/elsewhere/stale')
    const healthy = candidates.find((candidate) => candidate.disposal === 'trash')
    expect(healthy?.canonicalPath).toBe('/Users/dev/elsewhere/scratch')
    expect(healthy?.branchLabel).toBe('scratch')
    expect(healthy?.prunableReason).toBeUndefined()
  })

  test('porcelain parsing never mistakes path text for attributes', () => {
    const hostile = parseWorktreePorcelain(
      [
        'worktree /tmp/repo',
        'branch refs/heads/main',
        '',
        'worktree /tmp/evil prunable bare locked detached',
        '',
      ].join('\n')
    )
    expect(hostile).toHaveLength(2)
    expect(hostile[1]?.path).toBe('/tmp/evil prunable bare locked detached')
    expect(hostile[1]?.prunable).toBeUndefined()
    expect(hostile[1]?.bare).toBe(false)
  })

  test('scan offers prune candidates under the configured roots', async () => {
    const { report } = await scanned(junkMachine(), {
      scanRoots: () => ['/Users/dev/projects/primary'],
      gitWorktreeList: (root: string) => (root === '/Users/dev/projects/primary' ? porcelain : ''),
    })
    const worktrees = report.items.filter((item) => item.section === 'worktree')
    // Only the stale entry lists: the healthy scratch checkout has no
    // directory on this machine, so the scan proves it away; a trash item is
    // never a nonexistent path.
    expect(worktrees).toHaveLength(1)
    expect(worktrees[0]?.disposal).toBe('prune')
    expect(worktrees[0]?.worktree?.registered).toBe(false)
  })

  test('scan lists a healthy unregistered worktree as a Trash item', async () => {
    const machine = junkMachine()
    const elsewhere = machine.get('Users')!.children!.get('dev')!.children!
    elsewhere.set('elsewhere', dir({ scratch: dir({ 'some-file': file(10) }) }))
    const { report } = await scanned(machine, {
      scanRoots: () => ['/Users/dev/projects/primary'],
      gitWorktreeList: (root: string) => (root === '/Users/dev/projects/primary' ? porcelain : ''),
    })
    const worktrees = report.items.filter((item) => item.section === 'worktree')
    expect(worktrees.map((item) => item.label).toSorted()).toEqual(['scratch', 'stale'])
    const scratch = worktrees.find((item) => item.label === 'scratch')
    expect(scratch?.disposal).toBe('trash')
    expect(scratch?.worktree?.registered).toBe(false)
    expect(scratch?.worktree?.prunableReason).toBeUndefined()
  })
})

describe('janitor measure: bounded, honest sizes', () => {
  test('sums subtree bytes without following symlinks or crossing kinds', () => {
    const fs = fixtureFs(junkMachine())
    const outcome = measureBytes(
      fs,
      `${roots.derived_data}/MyApp-abc123`,
      { deadlineMs: NOW + 1_000, maxEntries: 1_000, maxDepth: 12 },
      () => NOW
    )
    expect(outcome).toEqual({ state: 'measured', bytes: 4096 + 4096 + 500 })
  })

  test('a missing or symlinked root is unreadable, never zero', () => {
    const fs = fixtureFs(junkMachine())
    expect(
      measureBytes(
        fs,
        `${roots.derived_data}/gone`,
        { deadlineMs: NOW, maxEntries: 10, maxDepth: 4 },
        () => NOW
      )
    ).toEqual({ state: 'unreadable' })
  })

  test('an exhausted budget reports stale without a fabricated size', () => {
    const fs = fixtureFs(junkMachine())
    const outcome = measureBytes(
      fs,
      `${roots.derived_data}/MyApp-abc123`,
      { deadlineMs: NOW - 1, maxEntries: 1_000, maxDepth: 12 },
      () => NOW
    )
    expect(outcome.state).toBe('stale')
  })

  test('measure fills sizes and the fresh cache short-circuits', async () => {
    const { janitor, report } = await scanned(junkMachine())
    const target = report.items.find((item) => item.label === 'old-download.zip')
    expect(target?.state).toBe('discovered')
    const first = await janitor.measure([target!.id])
    expect(first.items[0]?.state).toBe('measured')
    expect(first.items[0]?.bytes).toBe('90000')
    expect(replyDecodes('dev.resources.janitorMeasure', first)).toBe(true)
    // Unknown ids read as absent.
    const unknown = await janitor.measure(['jn-does-not-exist'])
    expect(unknown.items).toHaveLength(0)
  })
})

describe('janitor plan/commit: explicit, proven, recoverable', () => {
  async function planned(machine = junkMachine()) {
    const { janitor, report } = await scanned(machine)
    const target = report.items.find((item) => item.label === 'MyApp-abc123')!
    await janitor.measure([target.id])
    const plan = await janitor.plan({
      itemIds: [target.id],
      expectedGeneration: report.observationGeneration,
    })
    return { janitor, report, target, plan }
  }

  test('plan refuses to exist before a scan, on a stale generation, or for an unknown id', async () => {
    const janitor = authority(junkMachine())
    await expect(janitor.plan({ itemIds: ['jn-x'], expectedGeneration: 1 })).rejects.toMatchObject({
      code: 'invalid_state',
    })
    const { janitor: scannedJanitor, report } = await scanned(junkMachine())
    await expect(
      scannedJanitor.plan({ itemIds: [report.items[0]!.id], expectedGeneration: 99 })
    ).rejects.toMatchObject({ code: 'stale_generation' })
    await expect(
      scannedJanitor.plan({
        itemIds: ['jn-unknown'],
        expectedGeneration: report.observationGeneration,
      })
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  test('the plan names its items, sums measured bytes, and carries a sha256 digest', async () => {
    const { plan } = await planned()
    expect(plan.items).toHaveLength(1)
    expect(plan.totalBytes).toBe(String(4096 + 4096 + 500))
    expect(plan.plan.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(plan.plan.resource).toEqual({
      kind: 'janitor_plan',
      id: plan.plan.id,
      generation: plan.plan.resource.generation,
    })
    expect(replyDecodes('dev.resources.janitorPlan', plan)).toBe(true)
  })

  test('the commit moves junk into the Trash and never touches anything else', async () => {
    const machine = junkMachine()
    const { janitor, plan, target } = await planned(machine)
    const result = await janitor.commit(
      { planId: plan.plan.id, planDigest: plan.plan.digest },
      plan.plan.resource
    )
    expect(result.outcomes).toEqual([
      { itemId: target.id, outcome: 'trashed', detail: '~/.Trash/MyApp-abc123' },
    ])
    expect(replyDecodes('dev.resources.janitorCommit', result)).toBe(true)
    const derived = ((machine.get('Users') as FsNode).children as Map<string, FsNode>)
      .get('dev')!
      .children!.get('Library')!
      .children!.get('Developer')!
      .children!.get('Xcode')!
      .children!.get('DerivedData')!.children as Map<string, FsNode>
    const trash = ((machine.get('Users') as FsNode).children as Map<string, FsNode>)
      .get('dev')!
      .children!.get('.Trash')!.children as Map<string, FsNode>
    expect(derived.has('MyApp-abc123')).toBe(false)
    expect(trash.has('MyApp-abc123')).toBe(true)
  })

  test('a changed identity is skipped, not disposed', async () => {
    const machine = junkMachine()
    const { janitor, plan } = await planned(machine)
    // Replace the entry with a different directory before the commit.
    const derived = ((machine.get('Users') as FsNode).children as Map<string, FsNode>)
      .get('dev')!
      .children!.get('Library')!
      .children!.get('Developer')!
      .children!.get('Xcode')!
      .children!.get('DerivedData')!.children as Map<string, FsNode>
    derived.set('MyApp-abc123', dir({ replaced: file(1) }, NOW - 1))
    const result = await janitor.commit(
      { planId: plan.plan.id, planDigest: plan.plan.digest },
      plan.plan.resource
    )
    expect(result.outcomes[0]?.outcome).toBe('skipped')
    expect(derived.has('MyApp-abc123')).toBe(true)
  })

  test('the plan is single use and defends its binding and digest', async () => {
    const { janitor, plan } = await planned()
    await expect(
      janitor.commit(
        { planId: plan.plan.id, planDigest: plan.plan.digest },
        { ...plan.plan.resource, kind: 'process' }
      )
    ).rejects.toMatchObject({ code: 'identity_mismatch' })
    await expect(
      janitor.commit(
        { planId: plan.plan.id, planDigest: plan.plan.digest },
        { ...plan.plan.resource, generation: plan.plan.resource.generation + 1 }
      )
    ).rejects.toMatchObject({ code: 'stale_generation' })
    await expect(
      janitor.commit({ planId: plan.plan.id, planDigest: `${'0'.repeat(64)}` }, plan.plan.resource)
    ).rejects.toMatchObject({ code: 'invalid_state' })
    const first = await janitor.commit(
      { planId: plan.plan.id, planDigest: plan.plan.digest },
      plan.plan.resource
    )
    expect(first.outcomes[0]?.outcome).toBe('trashed')
    await expect(
      janitor.commit({ planId: plan.plan.id, planDigest: plan.plan.digest }, plan.plan.resource)
    ).rejects.toMatchObject({ code: 'plan_stale' })
  })

  test('emptying the Trash is permanent and only reaches Trash entries', async () => {
    const machine = junkMachine()
    const { janitor, report } = await scanned(machine)
    const entry = report.items.find((item) => item.label === 'old-download.zip')!
    const plan = await janitor.plan({
      itemIds: [entry.id],
      expectedGeneration: report.observationGeneration,
    })
    const result = await janitor.commit(
      { planId: plan.plan.id, planDigest: plan.plan.digest },
      plan.plan.resource
    )
    expect(result.outcomes).toEqual([{ itemId: entry.id, outcome: 'emptied' }])
    const trash = ((machine.get('Users') as FsNode).children as Map<string, FsNode>)
      .get('dev')!
      .children!.get('.Trash')!.children as Map<string, FsNode>
    expect(trash.has('old-download.zip')).toBe(false)
  })

  test('prune runs only while the worktree directory stays gone', async () => {
    const machine = junkMachine()
    const dev = ((machine.get('Users') as FsNode).children as Map<string, FsNode>).get('dev')!
    dev.children!.set('elsewhere', dir())
    const porcelain = [
      'worktree /Users/dev/projects/primary',
      'branch refs/heads/main',
      '',
      'worktree /Users/dev/elsewhere/stale',
      'branch refs/heads/stale',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n')
    const pruned: string[] = []
    const { janitor, report } = await scanned(machine, {
      scanRoots: () => ['/Users/dev/projects/primary'],
      gitWorktreeList: () => porcelain,
      gitWorktreePrune: (root: string) => {
        pruned.push(root)
      },
    })
    const item = report.items.find((entry) => entry.section === 'worktree')!
    const plan = await janitor.plan({
      itemIds: [item.id],
      expectedGeneration: report.observationGeneration,
    })
    // The directory reappeared: the prune is refused.
    const elsewhere = dev.children!.get('elsewhere')!.children as Map<string, FsNode>
    elsewhere.set('stale', dir())
    const refused = await janitor.commit(
      { planId: plan.plan.id, planDigest: plan.plan.digest },
      plan.plan.resource
    )
    expect(refused.outcomes[0]?.outcome).toBe('skipped')
    expect(pruned).toEqual([])
    // Gone again: the prune runs against the repository root.
    elsewhere.delete('stale')
    const plan2 = await janitor.plan({
      itemIds: [item.id],
      expectedGeneration: report.observationGeneration,
    })
    const done = (await janitor.commit(
      { planId: plan2.plan.id, planDigest: plan2.plan.digest },
      plan2.plan.resource
    )) as JanitorCommitResult
    expect(done.outcomes[0]?.outcome).toBe('pruned')
    expect(pruned).toEqual(['/Users/dev/projects/primary'])
  })

  test('a failed Trash move leaves the item in place and reports the failure', async () => {
    const machine = junkMachine()
    // A cross-device rename cannot move: the item fails and stays in place.
    const inner = fixtureFs(machine)
    const janitor = authority(machine, {
      fs: {
        ...inner,
        rename() {
          throw new Error('EXDEV: cross-device link not permitted')
        },
      },
    })
    const report = await janitor.scan()
    const target = report.items.find((item) => item.label === 'MyApp-abc123')!
    await janitor.measure([target.id])
    const plan = await janitor.plan({
      itemIds: [target.id],
      expectedGeneration: report.observationGeneration,
    })
    const result = await janitor.commit(
      { planId: plan.plan.id, planDigest: plan.plan.digest },
      plan.plan.resource
    )
    expect(result.outcomes[0]?.outcome).toBe('failed')
    const derived = ((machine.get('Users') as FsNode).children as Map<string, FsNode>)
      .get('dev')!
      .children!.get('Library')!
      .children!.get('Developer')!
      .children!.get('Xcode')!
      .children!.get('DerivedData')!.children as Map<string, FsNode>
    expect(derived.has('MyApp-abc123')).toBe(true)
  })

  test('destination naming deduplicates without overwriting', () => {
    expect(trashDestinationName(['a', 'b'], 'a')).toBe('a-2')
    expect(trashDestinationName(['a', 'a-2'], 'a')).toBe('a-3')
    expect(trashDestinationName([], 'a')).toBe('a')
  })

  test('the plan digest binds identities and disposal', () => {
    const facts = [
      { id: 'jn-a', disposal: 'trash' as const, identity: { device: '1', inode: '2' } },
      { id: 'jn-b', disposal: 'trash_empty' as const, identity: { device: '1', inode: '3' } },
    ]
    const reordered = facts.toReversed()
    expect(janitorPlanDigest(facts, 4)).toBe(janitorPlanDigest(reordered, 4))
    expect(janitorPlanDigest(facts, 4)).not.toBe(janitorPlanDigest(facts, 5))
    expect(
      janitorPlanDigest([{ ...facts[0]!, identity: { device: '1', inode: '9' } }], 4)
    ).not.toBe(janitorPlanDigest([facts[0]!], 4))
  })

  test('display paths abbreviate only the configured home', () => {
    expect(janitorPathLabel(HOME, `${HOME}/x/y`)).toBe('~/x/y')
    expect(janitorPathLabel(HOME, '/Elsewhere/x')).toBe('/Elsewhere/x')
  })
})
