// Opt-in negative controls for the host's synthetic child binding. host.mjs binds the timeline
// delivery port that CP's production child binding requires (CP #1204) with the transport principal
// and a notifier that sends nothing: the same synthetic binding CP's own governed-dispatch fixture
// uses. These cases prove the guard was not bypassed: with that port absent, or present without its
// principal, CP refuses to build the composition with PI_PRODUCTION_CHILD_BINDING_REQUIRED and the
// host never becomes ready. Needs the same inputs as the other joined lanes (a local PostgreSQL, a
// CP checkout at the pin named by PI_FACTORY_SOURCE_PIN, PI_FACTORY_BUN).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { startHarness } from './harness.mjs'

const directories = []
afterEach(() => {
  delete process.env.ADEA_CHILD_HOST_BINDING_NEGATIVE_CONTROL
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function refusal(control) {
  const directory = mkdtempSync(join(tmpdir(), 'host-binding-'))
  directories.push(directory)
  const log = join(directory, 'host-stderr.log')
  process.env.ADEA_CHILD_HOST_BINDING_NEGATIVE_CONTROL = control
  process.env.PI_FACTORY_HOST_LOG = log
  try {
    await startHarness({ allowanceSource: 'profile', title: `binding negative control ${control}` })
    return { started: true, stderr: '' }
  } catch (error) {
    // The host writes its failure to stderr just before it exits, which can land after the exit.
    await new Promise((resolve) => setTimeout(resolve, 500))
    let stderr = ''
    try {
      stderr = readFileSync(log, 'utf8')
    } catch {}
    return { started: false, message: String(error?.message ?? error), stderr }
  } finally {
    delete process.env.PI_FACTORY_HOST_LOG
  }
}

describe('the synthetic child binding does not bypass CP production guard', () => {
  for (const control of ['omit-timeline-delivery', 'timeline-delivery-without-principal'])
    test(`${control} is refused with PI_PRODUCTION_CHILD_BINDING_REQUIRED`, async () => {
      const result = await refusal(control)
      expect(result.started).toBe(false)
      expect(result.message).toBe('HOST_EXIT_BEFORE_READY')
      expect(result.stderr).toContain('PI_PRODUCTION_CHILD_BINDING_REQUIRED')
    }, 60000)
})
