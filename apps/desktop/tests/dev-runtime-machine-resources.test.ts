// Machine-wide resources (spec "Machine-wide inventory and foreign stop",
// threat TM-018): the bounded foreign inventory, the user-confirmed foreign
// stop, resource preferences, lazy worktree storage, and owned-process
// restart. Every OS observation runs through a scripted command runner over a
// fake process table, so the safety properties are asserted exactly: nothing
// is signalled on a changed identity, owner, or protection; children are
// signalled before their root; force is opt-in; and an incomplete
// observation is never reported as truth.
import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  DevCommand,
  DevOperation,
  ResourcePreferences,
  Scope,
} from '../../../packages/types/src/dev-runtime'
import type { CappedCommandResult } from '../shell/src/dev-runtime/resources/capped-command'
import { createCappedCommandRunner } from '../shell/src/dev-runtime/resources/capped-command'
import {
  createForeignStopAuthority,
  createLiveIdentityObserver,
} from '../shell/src/dev-runtime/resources/foreign-stop'
import {
  automationLabel,
  createMachineInventory,
  downsample,
  harnessFor,
  parseProcessListing,
  protectionFor,
  redactCommand,
} from '../shell/src/dev-runtime/resources/machine-inventory'
import {
  createMemoryResourcePreferenceStore,
  createResourcePreferenceStore,
  DEFAULT_RESOURCE_PREFERENCES,
  normalizeResourcePreferences,
} from '../shell/src/dev-runtime/resources/preferences'
import { registerResourcesRuntime } from '../shell/src/dev-runtime/resources/register'
import { createWorktreeStorage } from '../shell/src/dev-runtime/resources/worktree-storage'
import type { SupervisionRecord } from '../shell/src/supervision/records'
import type { SupervisionSnapshot } from '../shell/src/supervision/supervisor'

const SCOPE: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const SELF_UID = 501
const SELF_PID = 100
const HOME = '/Users/dev'
const START = 'Tue Oct  6 09:14:03 2026'
const START_NORMALIZED = 'Tue Oct 6 09:14:03 2026'

type Proc = {
  pid: number
  ppid: number
  uid?: number
  rssKiB?: number
  time?: string
  start?: string
  comm: string
  args?: string
}

/** A fake process table plus the listener and cwd answers lsof would give. */
function machine(
  initial: Proc[],
  extra: { listeners?: Record<number, number[]>; cwd?: Record<number, string> } = {}
) {
  const table = new Map<number, Proc>(initial.map((proc) => [proc.pid, proc]))
  const calls: string[][] = []
  const ok = (stdout: string): CappedCommandResult => ({
    exitCode: 0,
    stdout,
    timedOut: false,
    truncated: false,
    spawnFailed: false,
  })
  let failListing = false
  const run = async (argv: readonly string[]): Promise<CappedCommandResult> => {
    calls.push([...argv])
    const joined = argv.join(' ')
    if (joined === 'ps -axww -o pid=,ppid=,uid=,rss=,time=,lstart=,comm=') {
      if (failListing) return { ...ok('  1 0 0 1 0:00.01'), timedOut: true }
      return ok(
        [...table.values()]
          .map(
            (proc) =>
              `${String(proc.pid).padStart(6)} ${proc.ppid} ${proc.uid ?? SELF_UID} ${proc.rssKiB ?? 1024} ${proc.time ?? '0:01.00'} ${proc.start ?? START} ${proc.comm}`
          )
          .join('\n')
      )
    }
    if (joined === 'ps -axww -o pid=,args=') {
      return ok(
        [...table.values()].map((proc) => `${proc.pid} ${proc.args ?? proc.comm}`).join('\n')
      )
    }
    if (joined === 'lsof -nP -iTCP -sTCP:LISTEN -F pcn') {
      const lines: string[] = []
      for (const [pid, ports] of Object.entries(extra.listeners ?? {})) {
        if (!table.has(Number(pid))) continue
        lines.push(`p${pid}`, 'cnode')
        for (const port of ports) lines.push(`n127.0.0.1:${port}`)
      }
      return lines.length === 0 ? { ...ok(''), exitCode: 1 } : ok(lines.join('\n'))
    }
    if (argv[0] === 'lsof' && argv.includes('cwd')) {
      const pids = (argv.at(-1) as string).split(',').map(Number)
      return ok(
        pids
          .filter((pid) => extra.cwd?.[pid])
          .flatMap((pid) => [`p${pid}`, `n${extra.cwd?.[pid]}`])
          .join('\n')
      )
    }
    if (argv[0] === 'ps' && argv[1] === '-o' && argv[2] === 'uid=,lstart=,comm=') {
      const proc = table.get(Number(argv[4]))
      if (!proc) return { ...ok(''), exitCode: 1 }
      return ok(`${proc.uid ?? SELF_UID} ${proc.start ?? START} ${proc.comm}`)
    }
    throw new Error(`unexpected command ${joined}`)
  }
  return {
    table,
    calls,
    run,
    failListing: (value: boolean) => {
      failListing = value
    },
  }
}

function prefs(overrides: Partial<ResourcePreferences> = {}): ResourcePreferences {
  return {
    ...DEFAULT_RESOURCE_PREFERENCES,
    version: 0,
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  } as ResourcePreferences
}

function inventoryOver(
  fake: ReturnType<typeof machine>,
  options: { preferences?: ResourcePreferences; owned?: number[]; now?: () => number } = {}
) {
  return createMachineInventory({
    run: fake.run,
    preferences: () => options.preferences ?? prefs(),
    ownedPids: () => new Set(options.owned ?? []),
    selfPid: SELF_PID,
    selfUid: SELF_UID,
    home: HOME,
    machineStats: () => ({
      memoryTotalBytes: 32 * 1024 ** 3,
      memoryFreeBytes: 20 * 1024 ** 3,
      disk: { freeBytes: 200 * 1024 ** 3, totalBytes: 1000 * 1024 ** 3 },
    }),
    ...(options.now ? { now: options.now } : {}),
  })
}

function command(
  operation: DevOperation,
  body: Record<string, unknown>,
  resource?: { kind: string; id: string; generation: number }
): DevCommand {
  return {
    schemaVersion: 1,
    operation,
    requestId: randomUUID(),
    nonce: 'A'.repeat(22),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    scope: SCOPE,
    capabilities: [],
    ...(resource ? { resource } : {}),
    body,
  } as DevCommand
}

async function errorOf(operation: () => unknown): Promise<{ code: string; message: string }> {
  try {
    await operation()
  } catch (error) {
    return error as { code: string; message: string }
  }
  throw new Error('expected the operation to fail closed')
}

// A small machine: launchd, the Adea shell (100) and its sidecar (101), a
// Terminal running a Claude Code session (300) whose `next dev` (310)
// listens on 4000 with a child (311), an orphaned debugger (400) on 9229,
// postgres (500) on 5432, Chrome for Testing (600) with a renderer (601), a
// root-owned daemon (700), and a large editor (800).
const BASE: Proc[] = [
  { pid: 1, ppid: 0, uid: 0, comm: '/sbin/launchd' },
  { pid: 90, ppid: 1, comm: '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal' },
  { pid: 100, ppid: 90, comm: '/Applications/Adea.app/Contents/MacOS/Adea' },
  { pid: 101, ppid: 100, comm: '/Applications/Adea.app/Contents/Resources/sidecar' },
  { pid: 300, ppid: 1, comm: '/opt/homebrew/bin/node', args: 'node /opt/homebrew/bin/claude' },
  {
    pid: 310,
    ppid: 300,
    rssKiB: 600 * 1024,
    comm: '/opt/homebrew/bin/node',
    args: `node ${HOME}/code/side/node_modules/.bin/next dev -p 4000 --api-key sk-live-123`,
  },
  { pid: 311, ppid: 310, rssKiB: 200 * 1024, comm: '/opt/homebrew/bin/node' },
  {
    pid: 400,
    ppid: 1,
    rssKiB: 1300 * 1024,
    comm: '/opt/homebrew/bin/node',
    args: 'node --inspect',
  },
  { pid: 500, ppid: 1, rssKiB: 100 * 1024, comm: '/opt/homebrew/opt/postgresql/bin/postgres' },
  {
    pid: 600,
    ppid: 1,
    rssKiB: 900 * 1024,
    comm: '/Users/dev/.cache/ms-playwright/chromium/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  },
  {
    pid: 601,
    ppid: 600,
    rssKiB: 500 * 1024,
    comm: '/Users/dev/.cache/ms-playwright/chromium/Google Chrome for Testing.app/Contents/Frameworks/Helper',
    args: 'Helper --type=renderer --enable-automation',
  },
  { pid: 700, ppid: 1, uid: 0, rssKiB: 50 * 1024, comm: '/usr/local/bin/root-daemon' },
  {
    pid: 800,
    ppid: 1,
    rssKiB: 2000 * 1024,
    comm: '/Applications/Editor.app/Contents/MacOS/Editor',
  },
]
const LISTENERS = { 310: [4000], 400: [9229], 500: [5432] }

describe('process listing parser', () => {
  test('keeps paths with spaces and normalizes the padded start identity', () => {
    const rows = parseProcessListing(
      `  600     1   501  921600 0:12.50 ${START} /Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing\n` +
        'garbage line\n' +
        `   0     0     0       0 0:00.00 ${START} kernel_task\n`
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      pid: 600,
      ppid: 1,
      uid: 501,
      residentBytes: 921_600 * 1024,
      startIdentity: START_NORMALIZED,
      executableIdentity:
        '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    })
  })

  test('a CPU time that looks like a clock does not confuse the start column', () => {
    const rows = parseProcessListing(`  42 1 501 10 09:14:03 ${START} /bin/sleep\n`)
    expect(rows[0]?.executableIdentity).toBe('/bin/sleep')
    expect(rows[0]?.startIdentity).toBe(START_NORMALIZED)
  })
})

describe('classification', () => {
  test('redaction masks secret values and shortens home', () => {
    expect(
      redactCommand(
        `node ${HOME}/app/server.js --api-key sk-1 --token=abc GITHUB_TOKEN=ghp_x --port 3000`,
        HOME
      )
    ).toBe('node ~/app/server.js --api-key •••• --token=•••• GITHUB_TOKEN=•••• --port 3000')
    expect(redactCommand('x'.repeat(400), HOME).length).toBe(160)
  })

  test('harness attribution uses fixed executable matchers, including script shims', () => {
    expect(
      harnessFor(
        { executableIdentity: '/opt/homebrew/bin/node' },
        'node /opt/homebrew/bin/claude',
        ['Claude Code']
      )
    ).toBe('Claude Code')
    expect(harnessFor({ executableIdentity: '/usr/local/bin/codex' }, undefined, ['Codex'])).toBe(
      'Codex'
    )
    // A harness that is not enabled is not attributed.
    expect(
      harnessFor({ executableIdentity: '/usr/local/bin/codex' }, undefined, ['Claude Code'])
    ).toBeUndefined()
  })

  test('automation apps are recognized from proof the process carries', () => {
    expect(
      automationLabel(
        {
          executableIdentity:
            '/x/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        },
        undefined
      )
    ).toBe('Chrome for Testing')
    expect(
      automationLabel(
        { executableIdentity: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
        'Chromium --remote-debugging-port=9222'
      )
    ).toBe('Chromium automation')
    expect(
      automationLabel(
        { executableIdentity: '/Applications/Safari.app/Contents/MacOS/Safari' },
        'Safari'
      )
    ).toBeUndefined()
  })

  test('protection: other users, the OS, Adea itself, and the protected list', () => {
    const context = {
      selfUid: SELF_UID,
      adeaPids: new Set([100, 90]),
      protectedExecutables: ['postgres', 'com.docker.*'],
    }
    expect(
      protectionFor({ pid: 700, uid: 0, executableIdentity: '/usr/local/bin/x' }, context)
    ).toBe('other_user')
    expect(
      protectionFor({ pid: 1, uid: SELF_UID, executableIdentity: '/sbin/launchd' }, context)
    ).toBe('system')
    expect(
      protectionFor(
        { pid: 90, uid: SELF_UID, executableIdentity: '/Applications/T.app/Contents/MacOS/T' },
        context
      )
    ).toBe('system')
    expect(
      protectionFor({ pid: 55, uid: SELF_UID, executableIdentity: '/usr/libexec/thing' }, context)
    ).toBe('system')
    expect(
      protectionFor({ pid: 56, uid: SELF_UID, executableIdentity: '/opt/pg/bin/postgres' }, context)
    ).toBe('protected_list')
    expect(
      protectionFor(
        { pid: 57, uid: SELF_UID, executableIdentity: '/usr/local/bin/com.docker.backend' },
        context
      )
    ).toBe('protected_list')
    expect(
      protectionFor(
        { pid: 58, uid: SELF_UID, executableIdentity: '/opt/homebrew/bin/node' },
        context
      )
    ).toBe('none')
  })

  test('downsampling keeps the first and last points', () => {
    const points = Array.from({ length: 100 }, (_, index) => index)
    const sampled = downsample(points, 30)
    expect(sampled).toHaveLength(30)
    expect(sampled[0]).toBe(0)
    expect(sampled.at(-1)).toBe(99)
  })
})

describe('machine inventory', () => {
  test('lists listeners, automation apps, and large processes, never Adea or its launches', async () => {
    const fake = machine(BASE, { listeners: LISTENERS, cwd: { 310: `${HOME}/code/side` } })
    const inventory = inventoryOver(fake, { owned: [101] })
    const { foreign, machine: summary } = await inventory.observe()
    const pids = foreign.map((record) => record.pid)
    // Listeners first, then by tree size.
    expect(pids.slice(0, 3).toSorted()).toEqual([310, 400, 500])
    expect(pids).toContain(600)
    expect(pids).toContain(800)
    expect(pids).not.toContain(100)
    expect(pids).not.toContain(101)
    // The renderer folds into its automation app, the child into next dev.
    expect(pids).not.toContain(601)
    expect(pids).not.toContain(311)

    const next = foreign.find((record) => record.pid === 310)!
    expect(next.attribution).toEqual({ kind: 'harness', harness: 'Claude Code' })
    expect(next.listeningPorts).toEqual([4000])
    expect(next.childCount).toBe(1)
    expect(next.residentBytes).toBe(String((600 + 200) * 1024 * 1024))
    expect(next.cwdLabel).toBe('~/code/side')
    expect(next.commandPreview).toContain('--api-key ••••')
    expect(next.commandPreview).not.toContain('sk-live')
    expect(next.stoppable).toBe(true)
    // The first sample has no CPU delta: absent, never zero.
    expect(next.cpuPercent).toBeUndefined()

    const chrome = foreign.find((record) => record.pid === 600)!
    expect(chrome.attribution).toEqual({ kind: 'automation', label: 'Chrome for Testing' })
    expect(chrome.residentBytes).toBe(String((900 + 500) * 1024 * 1024))

    const postgres = foreign.find((record) => record.pid === 500)!
    expect(postgres).toMatchObject({ protection: 'protected_list', stoppable: false })

    expect(summary).toMatchObject({
      memoryTotalBytes: String(32 * 1024 ** 3),
      memoryUsedBytes: String(12 * 1024 ** 3),
      diskFreeBytes: String(200 * 1024 ** 3),
    })
    expect(summary.cpuPercent).toBeUndefined()
  })

  test('servers started in an Adea terminal are listed and mapped to their worktree', async () => {
    const fake = machine(
      [
        ...BASE,
        // The PTY sidecar (101) hosts a login shell running a dev server.
        { pid: 120, ppid: 101, comm: '-zsh' },
        {
          pid: 121,
          ppid: 120,
          rssKiB: 300 * 1024,
          comm: '/opt/homebrew/bin/bun',
          args: 'bun run dev',
        },
        // An Adea helper (not under a shell) stays excluded.
        {
          pid: 130,
          ppid: 100,
          rssKiB: 3000 * 1024,
          comm: '/Applications/Adea.app/Contents/Frameworks/WebHelper',
        },
      ],
      {
        listeners: { ...LISTENERS, 121: [3000] },
        cwd: { 121: `${HOME}/code/adea/.worktrees/tokens-v2/apps/web` },
      }
    )
    const inventory = createMachineInventory({
      run: fake.run,
      preferences: () => prefs(),
      ownedPids: () => new Set([101]),
      worktreeRoots: () => [
        { id: 'wt-main', root: `${HOME}/code/adea` },
        { id: 'wt-tokens', root: `${HOME}/code/adea/.worktrees/tokens-v2` },
      ],
      selfPid: SELF_PID,
      selfUid: SELF_UID,
      home: HOME,
      machineStats: () => ({}),
    })
    const { foreign } = await inventory.observe()
    const server = foreign.find((record) => record.pid === 121)
    expect(server).toMatchObject({
      attribution: { kind: 'adea_terminal' },
      worktreeId: 'wt-tokens',
      listeningPorts: [3000],
      stoppable: true,
    })
    const pids = foreign.map((record) => record.pid)
    expect(pids).not.toContain(120)
    expect(pids).not.toContain(130)
    expect(pids).not.toContain(101)
  })

  test('adea coverage lists no foreign rows and runs no process scan', async () => {
    const fake = machine(BASE, { listeners: LISTENERS })
    const inventory = inventoryOver(fake, { preferences: prefs({ coverage: 'adea' }) })
    expect((await inventory.observe()).foreign).toEqual([])
    expect(fake.calls).toEqual([])
  })

  test('an incomplete process listing proves nothing and empties the lookup', async () => {
    const fake = machine(BASE, { listeners: LISTENERS })
    const inventory = inventoryOver(fake)
    const first = await inventory.observe()
    const id = first.foreign[0]!.id
    expect(inventory.lookup(id)).toBeDefined()
    fake.failListing(true)
    expect((await inventory.observe()).foreign).toEqual([])
    expect(inventory.lookup(id)).toBeUndefined()
  })

  test('ids are stable for a live process and change when the PID is reused', async () => {
    const fake = machine(BASE, { listeners: LISTENERS })
    let clock = 1_000_000
    const inventory = inventoryOver(fake, { now: () => clock })
    const before = (await inventory.observe()).foreign.find((record) => record.pid === 400)!
    clock += 2_500
    fake.table.set(400, { ...fake.table.get(400)!, time: '0:03.00' })
    const same = (await inventory.observe()).foreign.find((record) => record.pid === 400)!
    expect(same.id).toBe(before.id)
    expect(same.observationGeneration).toBe(before.observationGeneration)
    // 2 s of CPU over 2.5 s of wall time.
    expect(same.cpuPercent).toBeCloseTo(80, 5)
    expect(same.residentHistory).toHaveLength(2)

    clock += 2_500
    fake.table.set(400, { ...fake.table.get(400)!, start: 'Tue Oct  6 10:00:00 2026' })
    const reused = (await inventory.observe()).foreign.find((record) => record.pid === 400)!
    expect(reused.id).not.toBe(before.id)
  })

  test('the listener scan is rate limited to the visible sample interval', async () => {
    const fake = machine(BASE, { listeners: LISTENERS })
    let clock = 0
    const inventory = inventoryOver(fake, { now: () => clock })
    await inventory.observe()
    clock += 500
    await inventory.observe()
    clock += 2_000
    await inventory.observe()
    const scans = fake.calls.filter((argv) => argv.includes('-sTCP:LISTEN'))
    expect(scans).toHaveLength(2)
  })
})

describe('foreign stop', () => {
  async function setup() {
    const fake = machine(BASE, { listeners: LISTENERS })
    let preferences = prefs()
    const inventory = createMachineInventory({
      run: fake.run,
      preferences: () => preferences,
      ownedPids: () => new Set(),
      selfPid: SELF_PID,
      selfUid: SELF_UID,
      home: HOME,
      machineStats: () => ({}),
    })
    await inventory.observe()
    const signals: Array<[number, string]> = []
    let exitOn: 'SIGTERM' | 'SIGKILL' | 'never' = 'SIGTERM'
    const authority = createForeignStopAuthority({
      scope: SCOPE,
      inventory,
      observe: createLiveIdentityObserver(fake.run),
      selfUid: SELF_UID,
      sleep: async () => undefined,
      gracefulWindowMs: 0,
      killWindowMs: 0,
      signal: (pid, signal) => {
        signals.push([pid, signal])
        if (exitOn === signal) fake.table.delete(pid)
      },
      randomId: () => `plan-${signals.length}-${Math.random()}`,
    })
    const record = async (pid: number) =>
      (await inventory.observe()).foreign.find((entry) => entry.pid === pid)!
    const next = await record(310)
    return {
      protect: (list: string[]) => {
        preferences = prefs({ protectedExecutables: list })
      },
      fake,
      inventory,
      authority,
      signals,
      next,
      record,
      exitOn: (value: typeof exitOn) => {
        exitOn = value
      },
    }
  }

  function planCommand(id: string, generation: number, force = false) {
    return command(
      'dev.resources.foreignStopPlan',
      { foreignProcessId: id, expectedGeneration: generation, force, reason: 'stop next dev' },
      { kind: 'foreign_process', id, generation }
    )
  }

  function commitCommand(id: string, generation: number, planId: string, planDigest: string) {
    return command(
      'dev.resources.foreignStopCommit',
      { planId, planDigest },
      { kind: 'foreign_process', id, generation }
    )
  }

  test('signals children before the root and reports exactly which PIDs', async () => {
    const { authority, signals, next } = await setup()
    const planCmd = planCommand(next.id, next.observationGeneration)
    const plan = authority.plan(planCmd, planCmd.body)
    expect(plan.steps.map((step) => step.targetId)).toEqual(['311', '310'])
    const commitCmd = commitCommand(next.id, next.observationGeneration, plan.id, plan.digest)
    const result = await authority.commit(commitCmd, commitCmd.body)
    expect(result).toMatchObject({ outcome: 'stopped', signalledPids: [311, 310] })
    expect(signals).toEqual([
      [311, 'SIGTERM'],
      [310, 'SIGTERM'],
    ])
    // Single use.
    expect((await errorOf(() => authority.commit(commitCmd, commitCmd.body))).code).toBe(
      'plan_stale'
    )
  })

  test('a reused PID is never signalled', async () => {
    const { authority, signals, next, fake } = await setup()
    const planCmd = planCommand(next.id, next.observationGeneration)
    const plan = authority.plan(planCmd, planCmd.body)
    fake.table.set(310, { ...fake.table.get(310)!, start: 'Tue Oct  6 11:00:00 2026' })
    const commitCmd = commitCommand(next.id, next.observationGeneration, plan.id, plan.digest)
    expect((await errorOf(() => authority.commit(commitCmd, commitCmd.body))).code).toBe(
      'ownership_unproven'
    )
    expect(signals).toEqual([])
  })

  test('a process that became protected after planning is not signalled', async () => {
    const { authority, signals, next, protect } = await setup()
    const planCmd = planCommand(next.id, next.observationGeneration)
    const plan = authority.plan(planCmd, planCmd.body)
    // The user protects `node` between the plan and the confirmation; the
    // commit re-evaluates protection against the current list.
    protect(['node'])
    const commitCmd = commitCommand(next.id, next.observationGeneration, plan.id, plan.digest)
    expect((await errorOf(() => authority.commit(commitCmd, commitCmd.body))).code).toBe(
      'ownership_unproven'
    )
    expect(signals).toEqual([])
  })

  test('protected, unknown, and stale-generation rows are refused at plan time', async () => {
    const { authority, record, next } = await setup()
    const postgres = await record(500)
    const protectedCmd = planCommand(postgres.id, postgres.observationGeneration)
    expect((await errorOf(() => authority.plan(protectedCmd, protectedCmd.body))).code).toBe(
      'ownership_unproven'
    )
    const unknownCmd = planCommand('fp-unknown', 1)
    expect((await errorOf(() => authority.plan(unknownCmd, unknownCmd.body))).code).toBe(
      'not_found'
    )
    const staleCmd = planCommand(next.id, next.observationGeneration + 5)
    expect((await errorOf(() => authority.plan(staleCmd, staleCmd.body))).code).toBe(
      'stale_generation'
    )
    const wrongKind = command(
      'dev.resources.foreignStopPlan',
      { foreignProcessId: next.id, expectedGeneration: 1, reason: 'x' },
      { kind: 'process', id: next.id, generation: 1 }
    )
    expect((await errorOf(() => authority.plan(wrongKind, wrongKind.body))).code).toBe(
      'identity_mismatch'
    )
  })

  test('without force a process that ignores SIGTERM is reported, not killed', async () => {
    const { authority, signals, next, exitOn } = await setup()
    exitOn('never')
    const planCmd = planCommand(next.id, next.observationGeneration)
    const plan = authority.plan(planCmd, planCmd.body)
    const commitCmd = commitCommand(next.id, next.observationGeneration, plan.id, plan.digest)
    const result = await authority.commit(commitCmd, commitCmd.body)
    expect(result.outcome).toBe('still_running')
    expect(signals.every(([, signal]) => signal === 'SIGTERM')).toBe(true)
  })

  test('force escalates to SIGKILL only after the graceful window, with re-proof', async () => {
    const { authority, signals, next, exitOn } = await setup()
    exitOn('SIGKILL')
    const planCmd = planCommand(next.id, next.observationGeneration, true)
    const plan = authority.plan(planCmd, planCmd.body)
    const commitCmd = commitCommand(next.id, next.observationGeneration, plan.id, plan.digest)
    const result = await authority.commit(commitCmd, commitCmd.body)
    expect(result.outcome).toBe('forced')
    expect(signals).toEqual([
      [311, 'SIGTERM'],
      [310, 'SIGTERM'],
      [311, 'SIGKILL'],
      [310, 'SIGKILL'],
    ])
  })

  test('a process that already exited is reported without any signal', async () => {
    const { authority, signals, next, fake } = await setup()
    const planCmd = planCommand(next.id, next.observationGeneration)
    const plan = authority.plan(planCmd, planCmd.body)
    fake.table.delete(310)
    const commitCmd = commitCommand(next.id, next.observationGeneration, plan.id, plan.digest)
    expect((await authority.commit(commitCmd, commitCmd.body)).outcome).toBe('already_gone')
    expect(signals).toEqual([])
  })

  test('the commit rejects a wrong digest and a different generation', async () => {
    const { authority, next } = await setup()
    const planCmd = planCommand(next.id, next.observationGeneration)
    const plan = authority.plan(planCmd, planCmd.body)
    const badDigest = commitCommand(next.id, next.observationGeneration, plan.id, '0'.repeat(64))
    expect((await errorOf(() => authority.commit(badDigest, badDigest.body))).code).toBe(
      'invalid_state'
    )
    const plan2 = authority.plan(planCmd, planCmd.body)
    const badGeneration = commitCommand(
      next.id,
      next.observationGeneration + 1,
      plan2.id,
      plan2.digest
    )
    expect((await errorOf(() => authority.commit(badGeneration, badGeneration.body))).code).toBe(
      'stale_generation'
    )
  })
})

describe('resource preferences', () => {
  test('clamps numbers, drops unknown harnesses, and recovers field by field', () => {
    const normalized = normalizeResourcePreferences({
      coverage: 'everything',
      recognizedHarnesses: ['Claude Code', 'My Own Harness'],
      portRange: { from: 70_000, to: 80 },
      alerts: { residentBytesAbove: '1', growthWindowSeconds: 5 },
      sampling: { visibleSeconds: 0.5, backgroundSeconds: 'x' },
      protectedExecutables: ['postgres', '/bin/evil', 'postgres'],
    })
    expect(normalized.coverage).toBe('machine')
    expect(normalized.recognizedHarnesses).toEqual(['Claude Code'])
    expect(normalized.portRange).toEqual({ from: 80, to: 65_535 })
    expect(normalized.alerts.residentBytesAbove).toBe(String(256 * 1024 * 1024))
    expect(normalized.alerts.growthWindowSeconds).toBe(60)
    expect(normalized.alerts.growthBytes).toBe(DEFAULT_RESOURCE_PREFERENCES.alerts.growthBytes)
    expect(normalized.sampling).toEqual({ visibleSeconds: 2, backgroundSeconds: 60 })
    expect(normalized.protectedExecutables).toEqual(['postgres'])
  })

  test('updates are revision-checked and persist across a reload', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-resource-prefs-'))
    try {
      const store = createResourcePreferenceStore({ dataDir })
      expect(store.current().version).toBe(0)
      const updated = store.update(0, { ...DEFAULT_RESOURCE_PREFERENCES, coverage: 'adea' })
      expect(updated).toMatchObject({ coverage: 'adea', version: 1 })
      expect(() => store.update(0, DEFAULT_RESOURCE_PREFERENCES)).toThrow()
      const reloaded = createResourcePreferenceStore({ dataDir })
      expect(reloaded.current()).toMatchObject({ coverage: 'adea', version: 1 })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe('worktree storage', () => {
  function tree() {
    const root = mkdtempSync(join(tmpdir(), 'adea-storage-'))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'index.ts'), 'x'.repeat(10_000))
    mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'y'.repeat(50_000))
    symlinkSync('/etc', join(root, 'escape'))
    return root
  }

  test('measures lazily, splits build bytes, and never follows symlinks', async () => {
    const root = tree()
    try {
      const storage = createWorktreeStorage({ worktrees: () => [{ id: 'wt-1', root }] })
      expect(storage.list()[0]).toMatchObject({ worktreeId: 'wt-1', state: 'measuring' })
      await storage.idle()
      const [record] = storage.list()
      expect(record?.state).toBe('measured')
      expect(Number(record?.buildBytes)).toBeGreaterThanOrEqual(50_000)
      expect(Number(record?.sourceBytes)).toBeGreaterThanOrEqual(10_000)
      // /etc behind the symlink would be far larger than the tree.
      expect(Number(record?.sourceBytes)).toBeLessThan(10_000_000)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a walk out of budget reports stale and resumes on the next request', async () => {
    const root = tree()
    try {
      let clock = 0
      const storage = createWorktreeStorage({
        worktrees: () => [{ id: 'wt-1', root }],
        // Each clock read advances time, so the first walk exhausts its budget.
        now: () => (clock += 1),
        budgetMs: 3,
        concurrency: 1,
      })
      storage.list()
      await storage.idle()
      expect(storage.list()[0]?.state).toBe('stale')
      for (let attempt = 0; attempt < 20 && storage.list()[0]?.state !== 'measured'; attempt += 1)
        await storage.idle()
      expect(storage.list()[0]?.state).toBe('measured')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a missing root is unreadable with no bytes, never zero', async () => {
    const storage = createWorktreeStorage({
      worktrees: () => [{ id: 'wt-gone', root: join(tmpdir(), `adea-missing-${randomUUID()}`) }],
    })
    storage.list()
    await storage.idle()
    expect(storage.list()[0]).toEqual({ worktreeId: 'wt-gone', state: 'unreadable' })
  })
})

describe('registrar: machine coverage, restart, and settings', () => {
  function stubAuthority() {
    const providers: Partial<Record<DevOperation, (command: DevCommand) => unknown>> = {}
    return {
      providers,
      registerCommandProvider(operation: DevOperation, handler: (command: DevCommand) => unknown) {
        providers[operation] = handler
      },
    }
  }

  const LAUNCH = { pid: 4100, pidStartIdentity: 'start-a', executableIdentity: '/exe/a' }

  function supervision() {
    let generation = 1
    let launch = { ...LAUNCH }
    const records: SupervisionRecord[] = [
      {
        kind: 'launched',
        at: new Date(1_000).toISOString(),
        componentId: 'web',
        generation: 1,
        processRecordId: 'record-1',
        identity: launch,
        processGroup: 'grp',
      },
    ]
    const restarts: string[] = []
    return {
      restarts,
      journal: { list: () => records },
      view: {
        snapshot: () =>
          ({
            components: [
              {
                id: 'web',
                state: 'running',
                health: 'healthy',
                generation,
                launch: {
                  identity: launch,
                  processGroup: 'grp',
                  startedAt: new Date(1_000).toISOString(),
                },
                manifest: { version: '1.0.0', digestSha256: 'd'.repeat(64) },
              },
            ],
          }) as unknown as SupervisionSnapshot,
        requestStop: () => ({ ok: true as const, value: { confirmationId: 'c', generation } }),
        stop: async () => ({ ok: false as const, code: 'invalid_state', message: 'unused' }),
        async restart(componentId: string) {
          restarts.push(componentId)
          generation += 1
          launch = { pid: 4200, pidStartIdentity: 'start-b', executableIdentity: '/exe/a' }
          records.push({
            kind: 'exited',
            at: new Date(2_000).toISOString(),
            componentId,
            generation: 1,
            processRecordId: 'record-1',
            expected: true,
            exitDetail: 'restart',
          })
          records.push({
            kind: 'launched',
            at: new Date(2_000).toISOString(),
            componentId,
            generation,
            processRecordId: 'record-2',
            identity: launch,
            processGroup: 'grp',
          })
          return { ok: true as const, value: {} }
        },
      },
    }
  }

  test('restart re-fences the generation and returns the relaunched process', async () => {
    const authority = stubAuthority()
    const engine = supervision()
    registerResourcesRuntime({
      authority: authority as never,
      scope: SCOPE,
      supervision: engine.view,
      supervisionRecords: engine.journal,
      now: () => 3_000,
    })
    const resource = { kind: 'process', id: 'record-1', generation: 1 }
    const plan = (await authority.providers['dev.resources.restartPlan']!(
      command(
        'dev.resources.restartPlan',
        { processRecordId: 'record-1', expectedGeneration: 1, reason: 'restart web' },
        resource
      )
    )) as { id: string; digest: string; steps: { kind: string }[] }
    expect(plan.steps.map((step) => step.kind)).toEqual([
      'stop_owned_resource',
      'relaunch_owned_resource',
    ])
    const restarted = (await authority.providers['dev.resources.restartCommit']!(
      command('dev.resources.restartCommit', { planId: plan.id, planDigest: plan.digest }, resource)
    )) as { id: string; generation: number; pid: number }
    expect(engine.restarts).toEqual(['web'])
    expect(restarted).toMatchObject({ id: 'record-2', generation: 2, pid: 4200 })
  })

  test('restart without an engine restart fails closed', async () => {
    const authority = stubAuthority()
    const engine = supervision()
    const { restart: _restart, ...withoutRestart } = engine.view
    registerResourcesRuntime({
      authority: authority as never,
      scope: SCOPE,
      supervision: withoutRestart,
      supervisionRecords: engine.journal,
    })
    const error = await errorOf(() =>
      authority.providers['dev.resources.restartPlan']!(
        command(
          'dev.resources.restartPlan',
          { processRecordId: 'record-1', expectedGeneration: 1, reason: 'restart' },
          { kind: 'process', id: 'record-1', generation: 1 }
        )
      )
    )
    expect(error.code).toBe('capability_unavailable')
  })

  test('the snapshot carries foreign rows only under machine coverage', async () => {
    const fake = machine(BASE, { listeners: LISTENERS })
    const preferences = createMemoryResourcePreferenceStore()
    const authority = stubAuthority()
    registerResourcesRuntime({
      authority: authority as never,
      scope: SCOPE,
      preferences,
      machine: createMachineInventory({
        run: fake.run,
        preferences: () => preferences.current(),
        ownedPids: () => new Set(),
        selfPid: SELF_PID,
        selfUid: SELF_UID,
        home: HOME,
        machineStats: () => ({ memoryTotalBytes: 1024, memoryFreeBytes: 512 }),
      }),
    })
    const snapshot = (await authority.providers['dev.resources.snapshot']!(
      command('dev.resources.snapshot', {})
    )) as { foreign?: unknown[]; machine?: unknown }
    expect(snapshot.foreign?.length).toBeGreaterThan(0)
    expect(snapshot.machine).toBeDefined()

    const current = (await authority.providers['dev.resources.preferences']!(
      command('dev.resources.preferences', {})
    )) as ResourcePreferences
    const { version, updatedAt: _updatedAt, ...input } = current
    await authority.providers['dev.resources.preferencesUpdate']!(
      command('dev.resources.preferencesUpdate', {
        expectedVersion: version,
        preferences: { ...input, coverage: 'adea' },
      })
    )
    const adeaOnly = (await authority.providers['dev.resources.snapshot']!(
      command('dev.resources.snapshot', {})
    )) as { foreign?: unknown[]; machine?: unknown }
    expect(adeaOnly.foreign).toBeUndefined()
    expect(adeaOnly.machine).toBeUndefined()
  })

  test('foreign stop and settings updates fail closed when their seams are absent', async () => {
    const authority = stubAuthority()
    registerResourcesRuntime({ authority: authority as never, scope: SCOPE })
    const stop = await errorOf(() =>
      authority.providers['dev.resources.foreignStopPlan']!(
        command(
          'dev.resources.foreignStopPlan',
          { foreignProcessId: 'fp-1', expectedGeneration: 1, reason: 'x' },
          { kind: 'foreign_process', id: 'fp-1', generation: 1 }
        )
      )
    )
    expect(stop.code).toBe('capability_unavailable')
    const update = await errorOf(() =>
      authority.providers['dev.resources.preferencesUpdate']!(
        command('dev.resources.preferencesUpdate', {
          expectedVersion: 0,
          preferences: DEFAULT_RESOURCE_PREFERENCES,
        })
      )
    )
    expect(update.code).toBe('capability_unavailable')
    // Reads still answer with the defaults.
    expect(
      await authority.providers['dev.resources.preferences']!(
        command('dev.resources.preferences', {})
      )
    ).toMatchObject({ coverage: 'machine', version: 0 })
  })
})

describe('capped command runner', () => {
  test('kills a child that exceeds the output cap and reports it', async () => {
    const run = createCappedCommandRunner({ maxOutputBytes: 1024, timeoutMs: 5_000 })
    const result = await run(['sh', '-c', 'yes adea | head -c 100000'])
    expect(result.truncated).toBe(true)
    expect(result.stdout.length).toBeLessThanOrEqual(1024)
  })

  test('kills a child that exceeds the timeout and reports it', async () => {
    const run = createCappedCommandRunner({ timeoutMs: 100 })
    const result = await run(['sleep', '5'])
    expect(result.timedOut).toBe(true)
  })

  test('a missing executable is a spawn failure, not empty output', async () => {
    const run = createCappedCommandRunner()
    const result = await run([`adea-missing-${randomUUID()}`])
    expect(result.spawnFailed || result.exitCode !== 0).toBe(true)
  })
})
