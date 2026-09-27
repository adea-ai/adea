import { describe, expect, test } from 'bun:test'

import { createChatPresentationReporter } from '../src/lib/desktop-chat-presentation'

describe('desktop chat presentation hint', () => {
  test('prefers a mounted Chat conversation and falls back to the selected Dev session on disposal', async () => {
    const sent: Array<string | undefined> = []
    const reporter = createChatPresentationReporter((sessionId) => sent.push(sessionId))

    await reporter.setDevSession('dev-session')
    await reporter.setChatSession('chat-session')
    await reporter.setChatSession(undefined)
    await reporter.setDevSession(undefined)

    expect(sent).toEqual(['dev-session', 'chat-session', 'dev-session', undefined])
  })

  test('serializes asynchronous updates and keeps later selection after an earlier failure', async () => {
    const sent: Array<string | undefined> = []
    let rejectFirst: ((error: Error) => void) | undefined
    const reporter = createChatPresentationReporter((sessionId) => {
      if (sessionId === 'first')
        return new Promise<void>((_resolve, reject) => {
          rejectFirst = reject
        })
      sent.push(sessionId)
    })

    const first = reporter.setChatSession('first')
    const second = reporter.setChatSession('second')
    await Promise.resolve()
    rejectFirst?.(new Error('channel unavailable'))
    await Promise.all([first, second])

    expect(sent).toEqual(['second'])
  })

  test('swallows a presentation transport failure without failing the surface', async () => {
    const reporter = createChatPresentationReporter(() => {
      throw new Error('channel unavailable')
    })

    await expect(reporter.setChatSession('session')).resolves.toBeUndefined()
  })
})
