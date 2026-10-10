import { describe, expect, test } from 'bun:test'
import { createRoot, createSignal } from 'solid-js'

import { createLeadStatusPoll } from '../src/lib/lead-handoff-poll'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('lead status poll', () => {
  test('reads on arrival and on its interval while a turn needs it', async () => {
    let reads = 0
    const [wanted, setWanted] = createSignal(false)
    await createRoot(async (dispose) => {
      createLeadStatusPoll(
        () => {
          reads += 1
        },
        wanted,
        { intervalMs: 20 }
      )
      await tick()
      expect(reads).toBe(0)
      setWanted(true)
      await tick()
      await tick()
      expect(reads).toBeGreaterThanOrEqual(1)
      const settled = reads
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(reads).toBeGreaterThan(settled)
      dispose()
      const stopped = reads
      await new Promise((resolve) => setTimeout(resolve, 50))
      // Disposing the owner stops the poll.
      expect(reads).toBe(stopped)
    })
  })

  test('stopping the need stops the reads; a failing read keeps last state', async () => {
    let reads = 0
    const [wanted, setWanted] = createSignal(true)
    let fail = false
    await createRoot(async (dispose) => {
      createLeadStatusPoll(
        () => {
          reads += 1
          if (fail) throw new Error('transient read failure')
        },
        wanted,
        { intervalMs: 15 }
      )
      await new Promise((resolve) => setTimeout(resolve, 40))
      expect(reads).toBeGreaterThanOrEqual(1)
      fail = true
      const settled = reads
      await new Promise((resolve) => setTimeout(resolve, 40))
      // Failed polls still tick (and swallow) without clearing state.
      expect(reads).toBeGreaterThan(settled)
      setWanted(false)
      await tick()
      await tick()
      const stopped = reads
      await new Promise((resolve) => setTimeout(resolve, 40))
      expect(reads).toBe(stopped)
      dispose()
    })
  })
})
