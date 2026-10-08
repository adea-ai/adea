import '../../src/start/globals.css'
import { Button } from '@adea-ai/ui/components/ui/button'
import { createSignal, Show } from 'solid-js'
import { render } from 'solid-js/web'
import {
  MessageComposer,
  type ComposerSubmission,
} from '../../../../packages/workspace-ui/src/message-composer'

// Real mounted composer with deferred local callbacks; no HTTP or runtime claim.
function Harness() {
  const [channel, setChannel] = createSignal('first')
  const [drafts, setDrafts] = createSignal<Record<string, string>>({
    first: '',
    second: 'Independent second draft',
  })
  const [submissions, setSubmissions] = createSignal<readonly ComposerSubmission[]>([])
  let pending: { resolve: () => void; reject: (error: Error) => void } | undefined
  return (
    <>
      <Button onClick={() => pending?.resolve()}>Resolve send</Button>
      <Button onClick={() => pending?.reject(new Error('Scripted failure'))}>Reject send</Button>
      <Button onClick={() => setChannel(channel() === 'first' ? 'second' : 'first')}>
        Switch topic
      </Button>
      <output aria-label="Submissions">{JSON.stringify(submissions())}</output>
      <output aria-label="First draft">{drafts().first}</output>
      <Show when={channel()} keyed>
        {(current) => (
          <MessageComposer
            agents={[]}
            artifacts={[]}
            channelId={current}
            draft={drafts()[current] ?? ''}
            onDraftChange={(value) => setDrafts((previous) => ({ ...previous, [current]: value }))}
            onSubmit={(submission) => {
              setSubmissions((previous) => [...previous, submission])
              return new Promise<void>((resolve, reject) => {
                pending = { resolve, reject }
              })
            }}
          />
        )}
      </Show>
    </>
  )
}
render(() => <Harness />, document.querySelector('#harness-root')!)
