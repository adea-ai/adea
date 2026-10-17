// Bun test preload: refuse to start a test process whose database or server
// target is not local (see scripts/test-target-guard.mjs).
import { assertLocalTestTargets } from './test-target-guard.mjs'

assertLocalTestTargets()
