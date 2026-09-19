import { spawnSync } from 'node:child_process'

const rounds = Number(process.env.ADEA_DEV_RUNTIME_SOAK_ROUNDS ?? 20)
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 1000) {
  console.error('ADEA_DEV_RUNTIME_SOAK_ROUNDS must be an integer from 1 to 1000')
  process.exit(2)
}
for (let round = 1; round <= rounds; round += 1) {
  const result = spawnSync('bun', ['test', 'apps/desktop/tests/terminal-channel.test.ts'], {
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    console.error(`Dev Runtime soak failed on round ${round}/${rounds}`)
    process.exit(result.status ?? 1)
  }
}
console.log(`Dev Runtime soak passed: ${rounds} terminal-channel rounds`)
