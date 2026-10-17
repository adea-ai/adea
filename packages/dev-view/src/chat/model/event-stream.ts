import {
  openRuntimeEventStream as openCoreRuntimeEventStream,
  type OpenRuntimeEventStreamInput,
  type RuntimeEventStream,
} from './event-stream-core'
import { createRuntimeHistoryLoader, readRuntimeEventHistory } from './history'

export { eventIdentity } from './event-stream-core'
export type { OpenRuntimeEventStreamInput, RuntimeEventStream } from './event-stream-core'

/** Chat adds authenticated backward history to the shared live stream. */
export async function openRuntimeEventStream(
  input: OpenRuntimeEventStreamInput
): Promise<RuntimeEventStream> {
  const { replaceTranscript, ...stream } = await openCoreRuntimeEventStream(input)
  const history = createRuntimeHistoryLoader({
    state: stream.state,
    commit: (next) => {
      replaceTranscript(next, () => input.onHistoryAccepted?.(next.events))
    },
    read: (options) =>
      readRuntimeEventHistory({
        service: input.service,
        scope: input.scope,
        runtimeSessionId: input.runtimeSessionId,
        generation: input.generation,
        ...options,
      }),
  })
  return {
    ...stream,
    loadOlder: history.loadOlder,
    hasOlder: history.hasOlder,
    close: () => {
      history.close()
      stream.close()
    },
  }
}
