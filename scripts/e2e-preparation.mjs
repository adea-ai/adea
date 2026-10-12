import { spawn } from 'node:child_process'

// These steps use independent runner resources and must all finish before the
// browser suite starts. In particular, keep the full Playwright system
// dependency install: its fonts and native libraries are part of the CI
// browser environment.
export const e2ePreparationCommands = [
  { command: 'bun', args: ['scripts/e2e-setup.mjs'] },
  { command: 'bunx', args: ['playwright', 'install', '--with-deps', 'chromium'] },
  { command: 'bunx', args: ['turbo', 'run', 'build', '--filter=@adea-ai/web^...'] },
]

function runInheritedCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (status, signal) => {
      if (status === 0) {
        resolve()
        return
      }
      reject(
        new Error(
          `${command} ${args.join(' ')} failed with ${
            status === null ? `signal ${signal ?? 'unknown'}` : `exit code ${status}`
          }`
        )
      )
    })
  })
}

// Wait for every preparation process to settle before reporting failures. This
// avoids abandoning a sibling process if one command fails early.
export async function runE2ePreparation(runCommand = runInheritedCommand) {
  const results = await Promise.allSettled(
    e2ePreparationCommands.map(({ command, args }) => runCommand(command, [...args]))
  )
  const failures = results.flatMap((result, index) => {
    if (result.status === 'fulfilled') return []
    const { command, args } = e2ePreparationCommands[index]
    const reason = result.reason instanceof Error ? result.reason.message : String(result.reason)
    return [new Error(`${command} ${args.join(' ')} failed: ${reason}`, { cause: result.reason })]
  })
  if (failures.length > 0) throw new AggregateError(failures, 'E2E preparation failed')
}
