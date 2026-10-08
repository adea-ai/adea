import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { stopOwnedCandidateProcess } from './lead-host-process.mjs'

test('reaps its own child when graceful termination is ignored', async () => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)",
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  )
  const stopped = once(child, 'exit')
  try {
    await once(child.stdout, 'data')
    await stopOwnedCandidateProcess(child, stopped, 50)
    expect(child.signalCode).toBe('SIGKILL')
    expect(() => process.kill(child.pid, 0)).toThrow()
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await stopped
    }
  }
})
