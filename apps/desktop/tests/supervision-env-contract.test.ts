// Environment-injection negative test at the process-execution layer (M10
// #33): a spawned component's environment cannot smuggle unexpected
// variables. The exact env contract handed to `Bun.spawn` in the supervision
// adapter is a positive allowlist plus the declared component additions —
// the shell process's whole environment is never inherited — and the argv
// array is handed over verbatim, never as interpolated shell text.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildComponentEnv, createProcessAdapter } from '../shell/src/supervision/process-adapter'
import type { ComponentSpec } from '../shell/src/supervision/component-manifest'

const HOSTILE_INHERITED: Record<string, string> = {
  // Secret-shaped values that live in a desktop shell's environment.
  ADEA_TERMINAL_HOOK_KEY: 'hook-key-must-not-leak',
  GITHUB_TOKEN: 'ghp_hostile',
  AWS_SECRET_ACCESS_KEY: 'hostile-secret',
  MY_API_KEY: 'key-material',
  // Runtime-injection classics: these change or hijack a child's behavior.
  NODE_OPTIONS: '--require /tmp/hook.js',
  DYLD_INSERT_LIBRARIES: '/tmp/hook.dylib',
  LD_PRELOAD: '/tmp/hook.so',
  PYTHONSTARTUP: '/tmp/hook.py',
  ENV: '/tmp/hook.sh',
  BASH_ENV: '/tmp/hook.sh',
  // Anything unlisted, benign or not, is not authorized.
  SOME_VENDOR_TELEMETRY: 'beacon',
}

function specWith(id: string): ComponentSpec {
  return {
    id,
    product: `Product ${id}`,
    version: '1.0.0',
    platform: 'universal',
    arch: 'universal',
    digestSha256: 'a'.repeat(64),
    signature: 'c2ln',
    compatibility: { minAppVersion: '0.1.0', maxAppVersion: '99.0.0' },
    installLocation: `components/${id}`,
    installKind: 'bundled',
    dataLocation: `components/${id}`,
    startupPhase: 0,
    dependsOn: [],
    healthProbe: { kind: 'process', intervalMs: 15_000, unhealthyAfterMs: 45_000 },
    protocol: null,
    rollbackTargetVersion: null,
    required: true,
  }
}

describe('component environment allowlist (pure builder)', () => {
  test('drops every unlisted inherited key, including secret-shaped and injection classics', () => {
    const env = buildComponentEnv({
      ...HOSTILE_INHERITED,
      HOME: '/Users/dev',
      PATH: '/usr/bin:/bin',
    })
    for (const key of Object.keys(HOSTILE_INHERITED)) {
      expect(env[key]).toBeUndefined()
    }
    expect(JSON.stringify(env)).not.toContain('ghp_hostile')
    expect(JSON.stringify(env)).not.toContain('--require')
  })

  test('rebuilds exactly the allowlisted host keys', () => {
    const env = buildComponentEnv({
      HOME: '/Users/dev',
      PATH: '/usr/bin:/bin',
      TMPDIR: '/tmp/adea',
      USER: 'dev',
      LOGNAME: 'dev',
      LANG: 'en_US.UTF-8',
      LC_CTYPE: 'UTF-8',
      TZ: 'UTC',
      SHELL: '/bin/zsh',
      LC_ALL: undefined, // unset keys stay unset rather than becoming "undefined"
    })
    expect(Object.keys(env).toSorted()).toEqual(
      ['HOME', 'LANG', 'LC_CTYPE', 'LOGNAME', 'PATH', 'SHELL', 'TMPDIR', 'TZ', 'USER'].toSorted()
    )
  })

  test('declared component additions layer on top of the allowlist', () => {
    const env = buildComponentEnv(
      { HOME: '/Users/dev', PATH: '/usr/bin' },
      { ADEA_SIDECAR_VERSION: '1.2.3', ADEA_SIDECAR_IDENTITY: 'sidecar@1.2.3' }
    )
    expect(env.ADEA_SIDECAR_VERSION).toBe('1.2.3')
    expect(env.ADEA_SIDECAR_IDENTITY).toBe('sidecar@1.2.3')
    expect(env.PATH).toBe('/usr/bin')
    expect(Object.keys(env)).toHaveLength(4)
  })
})

describe('process adapter env/argv contract at the Bun.spawn seam', () => {
  const realSpawn = Bun.spawn
  const captured: { argv: string[]; options: Record<string, unknown> }[] = []

  beforeAll(() => {
    // Observe the exact contract the adapter hands to Bun.spawn without
    // launching a real component child. The observed pid is this test
    // process, so the adapter's identity loop observes a real, live process.
    ;(Bun as { spawn: typeof Bun.spawn }).spawn = ((argv: string[], options?: unknown) => {
      captured.push({ argv: [...argv], options: { ...(options as object) } })
      return { pid: process.pid, kill: () => {} } as Bun.Subprocess
    }) as typeof Bun.spawn
  })

  afterAll(() => {
    ;(Bun as { spawn: typeof Bun.spawn }).spawn = realSpawn
  })

  test('a hostile inherited environment never reaches the spawn call', async () => {
    const adapter = createProcessAdapter({
      sidecar: {
        argv: ['/bin/echo', 'sidecar'],
        env: { ADEA_SIDECAR_VERSION: 'smoke' },
      },
    })
    const previous: Record<string, string | undefined> = {}
    for (const key of Object.keys(HOSTILE_INHERITED)) {
      previous[key] = process.env[key]
      process.env[key] = HOSTILE_INHERITED[key]
    }
    try {
      const launched = await adapter.spawn(specWith('sidecar'), 1)
      // The spawn observed a live process (this test runner), so the launch
      // record proves the call chain reached the seam with a clean env.
      expect(launched.identity.pid).toBe(process.pid)
      expect(captured).toHaveLength(1)
      const env = captured[0]?.options.env as Record<string, string>
      for (const key of Object.keys(HOSTILE_INHERITED)) {
        expect(env[key]).toBeUndefined()
      }
      expect(JSON.stringify(env)).not.toContain('hook-key-must-not-leak')
      expect(env.ADEA_SIDECAR_VERSION).toBe('smoke')
      expect(env.HOME).toBe(process.env.HOME)
      expect(env.PATH).toBe(process.env.PATH)
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  test('argv metacharacter payloads are passed verbatim as one argument, never a shell line', async () => {
    const adapter = createProcessAdapter({
      'metachar-component': {
        // The packaging lane resolved this argv from a component spec whose
        // fields contained shell metacharacters; the adapter must forward it
        // untouched — an argv array is not a shell string.
        argv: ['/bin/echo', "x'; rm -rf /tmp/never-created; echo '$(whoami)", 'a`id`b', 'p|q&r'],
      },
    })
    await adapter.spawn(specWith('metachar-component'), 1)
    expect(captured[1]?.argv).toEqual([
      '/bin/echo',
      "x'; rm -rf /tmp/never-created; echo '$(whoami)",
      'a`id`b',
      'p|q&r',
    ])
    // The adapter never wraps the argv in a shell (no `sh -c`, no `bash -lc`).
    expect(captured[1]?.argv[0]).toBe('/bin/echo')
  })
})

describe('spawned child environment (real process, one bounded burst)', () => {
  test('a real child process observes only the allowlisted environment', () => {
    // End-to-end negative proof with one real, fast child: the exact object
    // buildComponentEnv produces is handed to a real exec, and the child's
    // own report contains none of the hostile values.
    const workDir = mkdtempSync(join(tmpdir(), 'adea-env-contract-'))
    const probe = join(workDir, 'probe-printenv')
    symlinkSync(process.execPath, probe)
    try {
      const env = buildComponentEnv(
        { ...HOSTILE_INHERITED, HOME: '/Users/dev', PATH: `${join(workDir, 'bin')}:/usr/bin:/bin` },
        { ADEA_SIDECAR_VERSION: 'smoke' }
      )
      const child = Bun.spawnSync(
        [probe, '-e', 'process.stdout.write(JSON.stringify(process.env))'],
        {
          env,
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 10_000,
        }
      )
      expect(child.exitCode).toBe(0)
      const seen = JSON.parse(child.stdout.toString()) as Record<string, string>
      for (const key of Object.keys(HOSTILE_INHERITED)) {
        expect(seen[key]).toBeUndefined()
      }
      expect(seen.ADEA_SIDECAR_VERSION).toBe('smoke')
      expect(seen.HOME).toBe('/Users/dev')
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })
})
