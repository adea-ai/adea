import '../../src/start/globals.css'
import { createSignal, Show } from 'solid-js'
import { render } from 'solid-js/web'
import {
  CreateGroupDialog,
  CreateRoomDialog,
  EditRoomDialog,
  RenameConversationDialog,
} from '../../../../packages/workspace-ui/src/create-workspace-dialogs'

function Harness() {
  const [kind, setKind] = createSignal('')
  const [calls, setCalls] = createSignal<unknown[]>([])
  const [fail, setFail] = createSignal(true)
  const save = async (value: unknown) => {
    setCalls((previous) => [...previous, value])
    if (fail()) throw new Error('Scripted request failure')
  }
  const close = () => setKind('')
  return (
    <>
      <button onClick={() => setKind('room')}>Open room</button>
      <button onClick={() => setKind('edit')}>Open edit</button>
      <button onClick={() => setKind('rename')}>Open rename</button>
      <button onClick={() => setKind('group')}>Open group</button>
      <output aria-label="Requests">{JSON.stringify(calls())}</output>
      <Show when={kind() === 'room'}>
        <CreateRoomDialog open busy={false} template="home" onClose={close} onCreate={save} />
      </Show>
      <Show when={kind() === 'edit'}>
        <EditRoomDialog
          open
          busy={false}
          initialName="Study"
          initialFunctionKey="study"
          roomName="Study"
          onClose={close}
          onSave={save}
        />
      </Show>
      <Show when={kind() === 'rename'}>
        <RenameConversationDialog
          open
          busy={false}
          initialTitle="Original"
          onClose={close}
          onSave={save}
        />
      </Show>
      <Show when={kind() === 'group'}>
        <CreateGroupDialog open busy={false} onClose={close} onCreate={save} />
      </Show>
      <button id="allow-success" onClick={() => setFail(false)}>
        Allow success
      </button>
    </>
  )
}
render(() => <Harness />, document.querySelector('#harness-root')!)
