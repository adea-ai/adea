// Dependency-light measurement samplers shared by the CLI and deterministic tests.
import { performance } from 'node:perf_hooks'

export async function sampleResponseHeaders(
  url,
  { request = fetch, now = () => performance.now() } = {}
) {
  const start = now()
  const response = await request(url, { redirect: 'manual' })
  // fetch resolves at response headers. Drain the body outside the timing
  // interval so transfer/decode time cannot inflate the TTFB proxy.
  const elapsedMs = now() - start
  await response.arrayBuffer()
  return { response, elapsedMs }
}

export function summarizeInteractionEvidence(steps, events, eventTimingSupported) {
  const unavailable = (reason, status = 'unavailable') => ({
    interactionStatus: status,
    interactionReason: reason,
    interactionCount: events.length,
    interactionWorstMs: null,
    requiredInteractions: steps,
  })
  if (steps.length !== 4 || steps.some((step) => !step.completed))
    return unavailable('required_interaction_failed')
  if (!eventTimingSupported) return unavailable('event_timing_unavailable')
  if (events.some((duration) => !Number.isFinite(duration) || duration < 0))
    return unavailable('invalid_interaction_observation', 'failed')
  if (events.length === 0) return unavailable('no_interaction_observations')
  return {
    interactionStatus: 'measured',
    interactionCount: events.length,
    interactionWorstMs: Math.round(Math.max(...events)),
    requiredInteractions: steps,
  }
}

export async function measureScriptedInteractions(page) {
  // Scripted interaction burst: the worst event-timing duration is an INP
  // proxy, not field INP.
  const interactionTargets = [
    () =>
      page
        .getByRole('button', { name: /search/i })
        .first()
        .click({ timeout: 5_000 }),
    () => page.keyboard.press('Escape'),
    () =>
      page
        .getByRole('button', { name: /user settings/i })
        .first()
        .click({ timeout: 5_000 }),
    () => page.keyboard.press('Escape'),
  ]
  const steps = []
  const names = ['search', 'dismiss_search', 'user_settings', 'dismiss_settings']
  for (const [index, act] of interactionTargets.entries()) {
    try {
      await act()
      await page.waitForTimeout(250)
      steps.push({ name: names[index], completed: true })
    } catch {
      // Continue for diagnostic coverage, but never claim a latency sample
      // when any required target/interaction could not execute.
      steps.push({ name: names[index], completed: false })
    }
  }
  await page.waitForTimeout(1_000)
  const metrics = await page.evaluate(() => {
    // eslint-disable-next-line no-underscore-dangle
    const buffer = window.__perfBuffer
    const events = buffer?.events ?? []
    return {
      lcpMs: Math.round(buffer?.lcp ?? 0),
      cls: Number((buffer?.cls ?? 0).toFixed(4)),
      events,
      eventTimingSupported: buffer?.eventTimingSupported === true,
    }
  })
  return {
    lcpMs: metrics.lcpMs,
    cls: metrics.cls,
    ...summarizeInteractionEvidence(steps, metrics.events, metrics.eventTimingSupported),
  }
}
