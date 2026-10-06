import '../../src/start/globals.css'
import { createSignal, Show } from 'solid-js'
import { render } from 'solid-js/web'
import { AboutDialog } from '@adea-ai/ui/components/composites/about-dialog'
import {
  CreateGroupDialog,
  CreateProjectDialog,
  EditProjectDialog,
  RenameConversationDialog,
} from '../../../../packages/workspace-ui/src/create-workspace-dialogs'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Input } from '@adea-ai/ui/components/ui/input'

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
      <Button onClick={() => setKind('project')}>Open project</Button>
      <Button onClick={() => setKind('edit')}>Open edit</Button>
      <Button onClick={() => setKind('rename')}>Open rename</Button>
      <Button onClick={() => setKind('group')}>Open group</Button>
      <Button onClick={() => setKind('about')}>Open about</Button>
      <Input aria-label="Shared input reference" value="Reference" />
      <output aria-label="Requests">{JSON.stringify(calls())}</output>
      <Show when={kind() === 'project'}>
        <CreateProjectDialog open busy={false} template="home" onClose={close} onCreate={save} />
      </Show>
      <Show when={kind() === 'edit'}>
        <EditProjectDialog
          open
          busy={false}
          initialName="Study"
          initialIconKey="study"
          projectName="Study"
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
      <Show when={kind() === 'about'}>
        <AboutDialog
          appName="Adea"
          appIcon="/icon.svg"
          copyright="Copyright © 2026 0xPlayerOne"
          open
          onOpenChange={(next) => {
            if (!next) close()
          }}
          platform="desktop"
          sourceUrl="https://github.com/adea-ai/adea"
          version="0.61.7"
        />
      </Show>
      <Button id="allow-success" onClick={() => setFail(false)}>
        Allow success
      </Button>
    </>
  )
}
render(() => <Harness />, document.querySelector('#harness-root')!)
