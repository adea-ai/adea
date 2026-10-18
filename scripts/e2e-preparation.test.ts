import { expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { e2ePreparationCommands, runE2ePreparation } from './e2e-preparation.mjs'

test('starts database, browser dependencies, and web build before waiting', async () => {
  const started: { command: string; args: string[] }[] = []
  const finish: (() => void)[] = []
  const preparation = runE2ePreparation((command, args) => {
    started.push({ command, args })
    return new Promise<void>((resolve) => finish.push(resolve))
  })

  expect(started).toEqual(e2ePreparationCommands)
  expect(started.map(({ command, args }) => [command, ...args])).toEqual([
    ['bun', 'scripts/e2e-setup.mjs'],
    ['bunx', 'playwright', 'install', '--with-deps', 'chromium'],
    ['bun', 'run', 'build:web-deps'],
  ])

  finish.forEach((resolve) => resolve())
  await preparation
})

test('waits for sibling preparation processes before surfacing a failure', async () => {
  const finish: { resolve: () => void; reject: (error: Error) => void }[] = []
  const preparation = runE2ePreparation(
    () =>
      new Promise<void>((resolve, reject) => {
        finish.push({ resolve, reject })
      })
  )

  finish[0]!.reject(new Error('database setup failed'))
  let settled = false
  const outcome = preparation.catch((error: unknown) => {
    settled = true
    return error
  })
  await Promise.resolve()
  expect(settled).toBe(false)

  finish[1]!.resolve()
  finish[2]!.resolve()
  const error = (await outcome) as AggregateError
  expect(error).toBeInstanceOf(AggregateError)
  expect(error.message).toBe('E2E preparation failed')
  expect(error.errors[0].message).toContain('database setup failed')
})

async function withPreparationCommands(mode: string, run: (log: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'adea-prep-command-'))
  const previous = process.env
  const log = join(directory, 'calls')
  try {
    writeFileSync(log, '')
    for (const name of ['bun', 'bunx']) {
      const executable = join(directory, name)
      writeFileSync(
        executable,
        `#!/bin/sh\nprintf '%s\\n' '${name} '"$*" >> "$PREP_LOG"\nif [ '${name}' = bunx ]; then\n  case "$PREP_MODE" in exit) exit 7 ;; signal) kill -TERM $$ ;; esac\nfi\nexit 0\n`
      )
      chmodSync(executable, 0o755)
    }
    process.env = { PATH: directory, PREP_LOG: log, PREP_MODE: mode }
    await run(log)
  } finally {
    process.env = previous
    rmSync(directory, { recursive: true, force: true })
  }
}

test('default preparation runs only the three fixture executables and awaits their completion', async () => {
  await withPreparationCommands('ok', async (log) => {
    await runE2ePreparation()
    expect(readFileSync(log, 'utf8').trim().split('\n').toSorted()).toEqual(
      e2ePreparationCommands.map(({ command, args }) => `${command} ${args.join(' ')}`).toSorted()
    )
  })
})

test.each([
  ['exit', 'exit code 7'],
  ['signal', 'signal SIGTERM'],
])('reports %s while still settling sibling commands', async (mode, message) => {
  await withPreparationCommands(mode, async (log) => {
    const error = (await runE2ePreparation().catch((caught: unknown) => caught)) as AggregateError
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.errors).toHaveLength(1)
    expect(error.errors[0].message).toContain(message)
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(3)
  })
})

test('aggregates missing executables and preserves non-Error failure causes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'adea-prep-missing-'))
  const previous = process.env
  try {
    process.env = { PATH: directory }
    const error = (await runE2ePreparation().catch((caught: unknown) => caught)) as AggregateError
    expect(error.errors).toHaveLength(3)
    for (const failure of error.errors)
      expect(failure.message).toMatch(/ENOENT|Executable not found/)
  } finally {
    process.env = previous
    rmSync(directory, { recursive: true, force: true })
  }
  const nonErrorFailure = (await runE2ePreparation(async () => {
    throw 'fixture refusal'
  }).catch((caught: unknown) => caught)) as AggregateError
  expect(nonErrorFailure.errors).toHaveLength(3)
  for (const failure of nonErrorFailure.errors) expect(failure.cause).toBe('fixture refusal')
})
