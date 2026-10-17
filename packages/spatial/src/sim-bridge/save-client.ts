import { parseSimCharacterValue } from './character'
import type { SimFrameRequestMessage, SimHostMessage } from './messages'

/**
 * Frame side of the acknowledged character save.
 *
 * `save` resolves `true` only when the host answers the very request it sent with
 * `saved: true`. A refusal, a failure, a timeout, a host dispose, `dispose()`, a second save while
 * one is open, an invalid value, a post that throws, and a late or mismatched answer all resolve
 * `false`, so the engine never shows a saved value the host did not commit.
 */

export type CharacterSaveClient = Readonly<{
  save(character: string): Promise<boolean>
  /** Feed every parsed host message in; unrelated ones are ignored. */
  receive(message: SimHostMessage): void
  /** Fails any open save. Call when the frame is torn down. */
  dispose(): void
}>

export type CharacterSaveClientOptions = Readonly<{
  post(message: SimFrameRequestMessage): void
  /** Longer than the host's own timeout so the host's answer normally arrives first. */
  timeoutMs?: number
  mintRequestId?: () => string
  schedule?: (run: () => void, ms: number) => () => void
}>

export const DEFAULT_SAVE_CLIENT_TIMEOUT_MS = 8_000

export function createCharacterSaveClient(
  options: CharacterSaveClientOptions
): CharacterSaveClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SAVE_CLIENT_TIMEOUT_MS
  const schedule =
    options.schedule ??
    ((run, ms) => {
      const id = setTimeout(run, ms)
      return () => clearTimeout(id)
    })
  let counter = 0
  const mint = options.mintRequestId ?? (() => `save${++counter}`)
  let open: { requestId: string; settle(saved: boolean): void } | null = null
  let disposed = false

  function failOpen() {
    open?.settle(false)
  }

  return {
    save(character) {
      if (disposed || open || parseSimCharacterValue(character) === null)
        return Promise.resolve(false)
      const requestId = mint()
      return new Promise<boolean>((resolve) => {
        const cancel = schedule(() => failOpen(), timeoutMs)
        const entry = {
          requestId,
          settle(saved: boolean) {
            if (open !== entry) return
            open = null
            cancel()
            resolve(saved)
          },
        }
        open = entry
        try {
          options.post({ type: 'frame.character.save', payload: { requestId, character } })
        } catch {
          entry.settle(false)
        }
      })
    },
    receive(message) {
      if (message.type === 'host.dispose') failOpen()
      else if (
        message.type === 'host.character.save.result' &&
        open?.requestId === message.payload.requestId
      )
        open.settle(message.payload.saved)
    },
    dispose() {
      disposed = true
      failOpen()
    },
  }
}
