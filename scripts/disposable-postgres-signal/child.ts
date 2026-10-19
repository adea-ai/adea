// A disposable subprocess for the owned-container teardown tests.
//
// The test creates this process, signals it, and asserts how it tore down. The
// signal targets this child only: nothing else in the test suite, and no
// parent or unrelated process, is ever signalled.

import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { attachOwnedContainerCleanup } from '../disposable-postgres-ci'

const [directory] = process.argv.slice(2)
if (!directory) {
  console.error('the signal test child needs a working directory')
  process.exit(2)
}

const containerRemovalLog = join(directory, 'container-removal.log')
const materialRemovalLog = join(directory, 'material-removal.log')
const readyPath = join(directory, 'ready')
const failRemoval = process.env.ADEA_SIGNAL_TEST_FAIL_REMOVAL === 'true'

attachOwnedContainerCleanup({
  name: 'adea-ci-postgres-owned',
  remove: (name) => {
    appendFileSync(containerRemovalLog, `${name}\n`)
    if (failRemoval) throw new Error('the disposable container removal failed')
  },
  removeTemporaryMaterial: () => {
    appendFileSync(materialRemovalLog, 'removed\n')
  },
  reportFailure: (message) => {
    console.error(`cleanup failure: ${message}`)
  },
})

writeFileSync(readyPath, 'ready')

// Stay alive until the test signals this process.
setInterval(() => {}, 1_000)
