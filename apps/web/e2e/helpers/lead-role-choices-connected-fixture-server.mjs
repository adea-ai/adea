import { createInterface } from 'node:readline'
import { startLeadRoleChoicesConnectedFixture } from './lead-role-choices-connected-fixture.mjs'

let fixture
let closing = false
const input = createInterface({ input: process.stdin })
const write = (value, callback) => process.stdout.write(`${JSON.stringify(value)}\n`, callback)

async function closeFixture() {
  if (closing) return
  closing = true
  try {
    await fixture?.close()
  } catch {}
}

process.once('SIGTERM', () => {
  void closeFixture().then(() => process.exit(0))
})

try {
  fixture = await startLeadRoleChoicesConnectedFixture()
  write({
    schemaVersion: 'adea-connected-role-fixture/v1',
    baseUrl: fixture.apiBaseUrl,
    workspaceId: fixture.workspaceId,
    channelId: fixture.channelId,
    credential: fixture.credential,
    expectedHead: fixture.expectedHead,
    source: fixture.source,
    installed: fixture.installed,
    packagePaths: fixture.packagePaths,
    hostSourceIdentity: fixture.hostSourceIdentity,
  })
} catch (error) {
  const phases = new Set([
    'configuration',
    'candidate-archive-verification',
    'candidate-source-verification',
    'module-loading',
    'runtime-configuration',
    'database-module-loading',
    'db-package-import',
    'db-driver-import',
    'temporary-session-import',
    'reader-imports',
    'reader-handler-import',
    'service-verifier-import',
    'admin-dependencies-import',
    'lead-product-composition-import',
    'application-database-import',
    'request-scope-import',
    'workspace-principal-import',
    'workspace-authorization-import',
    'desktop-request-guard-import',
    'workspace-response-import',
    'conversation-error-import',
    'route-handlers-import',
    'lead-target-import',
    'sdk-ports-import',
    'database-connection',
    'database-seed',
    'product-reader-setup',
    'signed-reader-start',
    'candidate-host-start',
    'candidate-host-spawn',
    'candidate-host-ready',
    'candidate-host-identity',
    'candidate-host-workspace',
    'candidate-host-principal',
    'candidate-host-profile',
    'candidate-profile-profileid',
    'candidate-profile-profileversion',
    'candidate-profile-profilerevision',
    'application-database',
    'lead-product-dependencies',
    'lead-product-composition',
    'fixture-api-start',
  ])
  let phase = 'startup'
  let reason = 'FIXTURE_INITIALIZATION_FAILED'
  let missingPackage
  let failureClass = 'Error'
  try {
    if (phases.has(error?.connectedFixturePhase)) phase = error.connectedFixturePhase
    if (/^[A-Za-z][A-Za-z0-9]{0,48}$/u.test(error?.connectedFixtureClass ?? ''))
      failureClass = error.connectedFixtureClass
    if (
      typeof error?.connectedFixtureMissingPackage === 'string' &&
      /^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/u.test(
        error.connectedFixtureMissingPackage
      )
    )
      missingPackage = error.connectedFixtureMissingPackage
  } catch {}
  try {
    const match = /^CONNECTED_FIXTURE_START_FAILED:([a-z-]+):([A-Z_]+)$/u.exec(error?.message ?? '')
    if (match && phases.has(match[1])) phase = match[1]
    if (
      match &&
      [
        'MODULE_NOT_FOUND',
        'PACKAGE_EXPORT_MISSING',
        'FIXTURE_ASSERTION_FAILED',
        'FIXTURE_INITIALIZATION_FAILED',
        'HOST_BINARY_MISSING',
        'HOST_BINARY_NOT_EXECUTABLE',
        'HOST_SPAWN_FAILED',
        'HOST_EXIT_BEFORE_READY',
        'HOST_EXIT_BEFORE_CONTROL_REPLY',
        'HOST_CONTROL_UNAVAILABLE',
        'HOST_LAUNCH_TIMEOUT',
        'HOST_CONTROL_TIMEOUT',
        'HOST_CLOSE_TIMEOUT',
        'HOST_REAP_TIMEOUT',
      ].includes(match[2])
    )
      reason = match[2]
  } catch {}
  write({
    schemaVersion: 'adea-connected-role-fixture/v1',
    failure: 'CONNECTED_FIXTURE_START_FAILED',
    phase,
    reason,
    failureClass,
    ...(missingPackage ? { missingPackage } : {}),
  })
  input.close()
  process.exitCode = 1
}

input.on('line', async (line) => {
  let command
  try {
    command = JSON.parse(line)
  } catch {
    return
  }
  if (typeof command?.id !== 'string' || typeof command?.command !== 'string') return
  let data
  try {
    if (!fixture) throw new Error('fixture unavailable')
    if (command.command === 'evidence') data = await fixture.evidence()
    else if (command.command === 'snapshot') data = await fixture.snapshot(command.intentId)
    else if (command.command === 'close') {
      await closeFixture()
      data = { closed: true }
    } else return
    if (command.command === 'close') {
      input.close()
      write({ controlId: command.id, data }, () => process.exit(0))
      return
    }
    write({ controlId: command.id, data })
  } catch {
    write({ controlId: command.id, failure: 'CONNECTED_FIXTURE_CONTROL_FAILED' })
    if (command.command === 'close') process.exit(1)
  }
})

input.on('close', () => {
  if (!closing) void closeFixture().then(() => (process.exitCode = 1))
})
