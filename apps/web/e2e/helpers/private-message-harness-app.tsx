import '../../src/start/globals.css'
import type { MessageSummary } from '@adea-ai/types'
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { MessageRow } from '../../../../packages/workspace-ui/src/message-row'

function message(id: string): MessageSummary {
  return {
    id,
    workspaceId: 'workspace-fixture',
    channelId: 'channel-fixture',
    bodyContentRefId: id,
    artifactIds: [],
    mentions: [],
    deleted: false,
    sender: { kind: 'system', systemId: 'adea' },
    sequence: 1,
    version: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }
}

function Harness() {
  const [current, setCurrent] = createSignal(message('first'))
  const pending = new Map<
    string,
    { resolve(value: { plaintext: string }): void; reject(error: Error): void }
  >()
  return (
    <>
      <button type="button" onClick={() => setCurrent(message('second'))}>
        Switch message
      </button>
      <button
        type="button"
        onClick={() => pending.get('first')?.resolve({ plaintext: 'Old private body' })}
      >
        Resolve old
      </button>
      <button
        type="button"
        onClick={() => pending.get('first')?.reject(new Error('fixture unavailable'))}
      >
        Reject old
      </button>
      <button
        type="button"
        onClick={() => pending.get('second')?.resolve({ plaintext: 'Current private body' })}
      >
        Resolve current
      </button>
      <MessageRow
        message={current()}
        agents={new Map()}
        artifacts={new Map()}
        privateContent={{
          read: ({ contentId }) =>
            new Promise((resolve, reject) => pending.set(contentId, { resolve, reject })),
        }}
      />
    </>
  )
}

render(() => <Harness />, document.querySelector('#harness-root')!)
