import { expect, test } from 'bun:test'
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
