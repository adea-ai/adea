import '../../src/start/globals.css'
import type { DevCommand, DevReply } from '@adea-ai/types/dev-runtime'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Show, createSignal } from 'solid-js'
import { render } from 'solid-js/web'

import { DevAddRepositoryDialog } from '../../../../packages/dev-view/src/sidebar/dev-nav-dialogs'

// The host's folder picker is the OS boundary. The spec selects how the fake host answers
// through window.pickerFixture, so every outcome is driven from the test without a native panel.
type PickerMode = 'pick' | 'reject' | 'throw' | 'hang'
type PickerFixture = { mode?: PickerMode; resolvePick?: (value: string | null) => void }
declare global {
  interface Window {
    pickerFixture?: PickerFixture
  }
}

const PROJECT_ID = '0d9e4f1a-2222-4000-8000-00000000c10d'

function Harness() {
  const [open, setOpen] = createSignal(true)
  const [pickerCalls, setPickerCalls] = createSignal(0)
  const [authorizeCalls, setAuthorizeCalls] = createSignal(0)

  const execute = async (command: DevCommand): Promise<DevReply> => {
    // Only the authorize step is counted: a picked path must never reach it without the user.
    if (command.operation === 'dev.project.authorizeRoot') setAuthorizeCalls((count) => count + 1)
    // The bookmark list loads when the form opens; an empty list is enough for these checks.
    const value = command.operation === 'dev.project.bookmarks' ? { items: [] } : null
    if (command.operation === 'dev.project.bookmarks')
      return {
        schemaVersion: 1,
        operation: command.operation,
        requestId: command.requestId,
        ok: true,
        value,
      }
    return {
      schemaVersion: 1,
      operation: command.operation,
      requestId: command.requestId,
      ok: false,
      error: {
        code: 'fixture_refusal',
        retryable: false,
        message: 'the picker fixture does not authorize folders',
      },
    }
  }

  const pickFolder = (): Promise<string | null | undefined> => {
    setPickerCalls((count) => count + 1)
    const fixture = (window.pickerFixture ??= {})
    const mode = fixture.mode ?? 'pick'
    if (mode === 'throw') throw new Error('the shell cannot open a panel')
    if (mode === 'reject') return Promise.reject(new Error('the shell failed to answer'))
    if (mode === 'hang')
      return new Promise<string | null>((resolve) => {
        fixture.resolvePick = resolve
      })
    return Promise.resolve('/Users/fixture/projects/app')
  }

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        Open repository dialog
      </Button>
      <Show when={open()}>
        <DevAddRepositoryDialog
          scope={{ accountId: 'account', workspaceId: 'workspace', runtimeNodeId: 'node' }}
          execute={execute}
          knownProjectNames={[]}
          projectId={PROJECT_ID}
          projectName="Fixture project"
          onImported={() => undefined}
          onClose={() => setOpen(false)}
          announce={() => undefined}
          pickFolder={pickFolder}
        />
      </Show>
      <output data-testid="ready">ready</output>
      <output data-testid="picker-calls">{pickerCalls()}</output>
      <output data-testid="authorize-calls">{authorizeCalls()}</output>
    </>
  )
}

render(() => <Harness />, document.getElementById('harness-root')!)
