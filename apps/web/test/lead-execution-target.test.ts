import { expect, test } from 'bun:test'
import { configuredLeadExecutionTarget } from '../src/server/lead-execution-target'
const target = {
  location: 'remote_host',
  harness: 'pi_durable',
  harnessVersion: '1.1.0',
  providerBinding: 'pi_durable_models',
}
test('production target requires explicit compatible operator destination and cannot imply readiness', () => {
  expect(configuredLeadExecutionTarget({})).toBeNull()
  expect(configuredLeadExecutionTarget({ PI_DURABLE_LEAD_ENABLED: 'true' })).toBeNull()
  expect(
    configuredLeadExecutionTarget({ PI_DURABLE_LEAD_TARGET: JSON.stringify(target) })
  ).toBeNull()
  const environment = {
    PI_DURABLE_LEAD_ENABLED: 'true',
    PI_DURABLE_LEAD_TARGET: JSON.stringify(target),
  }
  expect(configuredLeadExecutionTarget(environment)).toEqual(target)
  for (const change of [
    { harnessVersion: 'unknown' },
    { location: 'agent_hq_cloud' },
    { providerBinding: 'cloudflare_binding' },
    { ready: true },
  ])
    expect(
      configuredLeadExecutionTarget({
        ...environment,
        PI_DURABLE_LEAD_TARGET: JSON.stringify({ ...target, ...change }),
      })
    ).toBeNull()
})
