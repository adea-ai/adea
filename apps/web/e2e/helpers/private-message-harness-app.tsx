import '../../src/start/globals.css'
import type { MessageSummary, TaskSummary } from '@adea-ai/types'
import { createRenderEffect, createSignal, Show } from 'solid-js'
import { render } from 'solid-js/web'
import { MessageRow } from '../../../../packages/workspace-ui/src/message-row'
import { TaskObjective } from '../../../../packages/workspace-ui/src/private-task-objective'
import type { PrivateContentResolver } from '../../../../packages/workspace-ui/src/platform'

function SwitchObservation(props: { currentId: string; oldContent: string }) {
  const [observation, setObservation] = createSignal('waiting')
  createRenderEffect(() => {
    if (props.currentId !== 'second') return
    const currentSurface = document.querySelector('[data-message-id="second"]')
    if (currentSurface)
      setObservation(currentSurface.textContent?.includes(props.oldContent) ? 'stale' : 'clear')
  })
  return <output data-testid="switch-observation">{observation()}</output>
}

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
  const objective = new URLSearchParams(window.location.search).get('surface') === 'objective'
  const [current, setCurrent] = createSignal(message('first'))
  const pending = new Map<
    string,
    { resolve(value: { plaintext: string }): void; reject(error: Error): void }
  >()
  const privateContent: PrivateContentResolver = {
    read: ({ contentId }) =>
      new Promise((resolve, reject) => pending.set(contentId, { resolve, reject })),
  }
  const task = (): TaskSummary => ({
    id: current().id,
    workspaceId: current().workspaceId,
    title: 'Fixture task',
    kind: 'feature',
    objectiveContentRefId: current().id,
    artifactRefs: [],
    dependencyIds: [],
    conversation: {},
    creator: { kind: 'user', userId: 'fixture-user' },
    lifecycleState: 'created',
    priority: 'normal',
    version: 1,
    createdAt: current().createdAt,
    updatedAt: current().updatedAt,
  })
  return (
    <>
      <button type="button" onClick={() => setCurrent(message('second'))}>
        Switch message
      </button>
      <button
        type="button"
        onClick={() =>
          pending.get('first')?.resolve({
            plaintext: objective ? 'Old private objective' : 'Old private body',
          })
        }
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
        onClick={() =>
          pending.get('second')?.resolve({
            plaintext: objective ? 'Current private objective' : 'Current private body',
          })
        }
      >
        Resolve current
      </button>
      <Show
        when={objective}
        fallback={
          <MessageRow
            message={current()}
            agents={new Map()}
            artifacts={new Map()}
            privateContent={privateContent}
          />
        }
      >
        <div data-message-id={current().id}>
          <TaskObjective task={task()} privateContent={privateContent} />
        </div>
      </Show>
      <SwitchObservation
        currentId={current().id}
        oldContent={objective ? 'Old private objective' : 'Old private body'}
      />
    </>
  )
}

render(() => <Harness />, document.querySelector('#harness-root')!)
