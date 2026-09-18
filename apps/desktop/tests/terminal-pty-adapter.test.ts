// Issue #396 adapter contract: byte-preserving output, pre-assignment data
// callback buffering, typed capability state (no silent fallback), typed
// spawn failure, and write/resize/signal/exit. Real-Bun coverage runs on the
// repository-pinned Bun 1.4 line; the fixture path keeps every platform's
// contract testable.
import { describe, expect, test } from 'bun:test'

import { createBunPtyAdapter, type PtyProcess } from '../shell/src/dev-runtime/terminal/pty-adapter'
import { createFakePtyAdapter } from './fixtures/fake-pty'

function collectBytes(process: PtyProcess): { received: Uint8Array[]; text(): string } {
  const received: Uint8Array[] = []
  process.onData((data) => received.push(data))
  return {
    received,
    text: () =>
      received
        .map((chunk) => Array.from(chunk, (byte) => String.fromCharCode(byte)).join(''))
        .join(''),
  }
}

describe('bun pty adapter contract', () => {
  test('reports unsupported platforms as typed capability state, never a fallback', () => {
    const adapter = createBunPtyAdapter('win32')
    expect(adapter.capability).toEqual({
      supported: false,
      platform: 'win32',
      reason: 'pty_requires_posix_process_groups',
    })
    const result = adapter.spawn({
      shell: '/bin/sh',
      args: [],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      env: {},
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('unsupported_capability')
      expect(result.message).toContain('win32')
    }
  })

  test('buffers data emitted by the synchronous callback before the wrapper is assigned', async () => {
    // A child that writes during spawn exercises Bun's synchronous
    // terminal.data callback: every source byte must survive even though the
    // listener list cannot exist yet (t3code drops this window; Adea buffers it).
    const adapter = createBunPtyAdapter(process.platform)
    if (!adapter.capability.supported) return
    const spawned = adapter.spawn({
      shell: '/bin/echo',
      args: ['adea-pty-preassignment'],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      env: { PATH: process.env.PATH ?? '' },
    })
    expect(spawned.ok).toBe(true)
    if (!spawned.ok) return
    const collector = collectBytes(spawned.value)
    await Bun.sleep(120)
    expect(collector.text()).toContain('adea-pty-preassignment')
    spawned.value.kill('SIGKILL')
  })

  test('survives a spawn failure as a typed error', () => {
    const fake = createFakePtyAdapter()
    fake.failNextSpawnWith('spawn_failed', 'no such shell')
    const result = fake.adapter.spawn({
      shell: '/nonexistent-shell',
      args: [],
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      env: {},
    })
    expect(result).toEqual({ ok: false, code: 'spawn_failed', message: expect.any(String) })
  })

  test('forwards write, resize, and signals to the process', () => {
    const fake = createFakePtyAdapter()
    const spawned = fake.adapter.spawn({
      shell: '/bin/zsh',
      args: ['-l'],
      cwd: '/tmp/worktree',
      cols: 100,
      rows: 30,
      env: { TERM: 'xterm-256color' },
    })
    expect(spawned.ok).toBe(true)
    if (!spawned.ok) return
    spawned.value.write(new TextEncoder().encode('ls\n'))
    spawned.value.resize(120, 40)
    spawned.value.kill('SIGTERM')
    expect(fake.processes[0]!.written.map((bytes) => new TextDecoder().decode(bytes))).toEqual([
      'ls\n',
    ])
    expect(fake.processes[0]!.resizes).toEqual([{ cols: 120, rows: 40 }])
    expect(fake.processes[0]!.kills).toEqual(['SIGTERM'])
    expect(fake.spawnInputs[0]).toMatchObject({
      shell: '/bin/zsh',
      args: ['-l'],
      cwd: '/tmp/worktree',
      cols: 100,
      rows: 30,
    })
  })
})

describe('real bun pty on this platform', () => {
  test.skipIf(process.platform === 'win32')(
    'keeps fragmented invalid UTF-8 byte-exact',
    async () => {
      // The adapter contract is byte-preserving: CJK text split across chunk
      // boundaries plus a lone 0xFF byte must arrive without replacement or loss.
      const adapter = createBunPtyAdapter(process.platform)
      if (!adapter.capability.supported) return
      const spawned = adapter.spawn({
        shell: '/bin/sh',
        args: ['-c', 'printf "héllo\\xffwörld"'],
        cwd: '/tmp',
        cols: 80,
        rows: 24,
        env: { PATH: process.env.PATH ?? '' },
      })
      expect(spawned.ok).toBe(true)
      if (!spawned.ok) return
      const collector = collectBytes(spawned.value)
      await Bun.sleep(250)
      const raw = collector.received.map((chunk) => [...chunk]).flat()
      const text = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(raw))
      expect(text).toContain('héllo')
      expect(text).toContain('wörld')
      expect(raw.includes(0xff)).toBe(true)
      spawned.value.kill('SIGKILL')
    }
  )
})
