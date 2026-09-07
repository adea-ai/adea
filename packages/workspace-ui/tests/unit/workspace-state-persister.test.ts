import { describe, expect, test } from 'bun:test'

import { createWorkspaceStatePersister } from '../../src/workspace-state-persister'

type PersistedState = Record<string, unknown>

function createRecorder() {
  const writes: PersistedState[] = []
  return {
    writes,
    write: (state: PersistedState) => void writes.push(state),
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('workspace state persister', () => {
  test('coalesces a burst of changes into one trailing write of the latest state', async () => {
    const recorder = createRecorder()
    const persister = createWorkspaceStatePersister(recorder.write, 20)

    persister.save({ change: 1 })
    persister.save({ change: 2 })
    persister.save({ change: 3 })
    await sleep(60)

    expect(recorder.writes).toEqual([{ change: 3 }])
  })

  test('flush writes pending state immediately and cancels the scheduled write', async () => {
    const recorder = createRecorder()
    const persister = createWorkspaceStatePersister(recorder.write, 20)

    persister.save({ change: 1 })
    persister.flush()
    await sleep(60)

    expect(recorder.writes).toEqual([{ change: 1 }])
  })

  test('flush without pending state is a no-op', () => {
    const recorder = createRecorder()
    const persister = createWorkspaceStatePersister(recorder.write, 20)

    expect(() => persister.flush()).not.toThrow()
    expect(recorder.writes).toEqual([])
  })

  test('writes scheduled before a flush do not fire twice', async () => {
    const recorder = createRecorder()
    const persister = createWorkspaceStatePersister(recorder.write, 20)

    persister.save({ change: 1 })
    persister.flush()
    persister.save({ change: 2 })
    await sleep(60)

    expect(recorder.writes).toEqual([{ change: 1 }, { change: 2 }])
  })
})
