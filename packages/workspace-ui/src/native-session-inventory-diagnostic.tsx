import { SettingsSection } from '@adea-ai/ui/components/composites/settings'
import { Button } from '@adea-ai/ui/components/ui/button'
import { EmptyDescription } from '@adea-ai/ui/components/ui/empty'
import { createEffect, createSignal, onCleanup, Show } from 'solid-js'

import { NATIVE_SESSION_INVENTORY_MAX_OUTPUT_BYTES } from '@adea-ai/types/native-session-inventory'
import type { MigrationSnapshotSection } from '@adea-ai/types'

import type { NativeSessionInventoryDiagnosticService } from './platform'
import { savePortableFile } from './workspace-portable-model'

type DiagnosticState =
  | Readonly<{ status: 'idle' }>
  | Readonly<{ bindingIdentity: string | undefined; status: 'capturing' }>
  | Readonly<{
      bindingIdentity: string | undefined
      section: MigrationSnapshotSection<'nativeSessions'>
      status: 'captured'
    }>
  | Readonly<{
      reason: 'cancelled' | 'ownership_mismatch' | 'read_failed' | 'timed_out' | 'unavailable'
      status: 'unknown'
    }>

const unknownMessages = {
  cancelled: 'Capture was cancelled. No partial inventory was saved.',
  ownership_mismatch:
    'The selected workspace or host no longer matches the signed desktop scope. The inventory is unknown.',
  read_failed: 'The local runtime did not return a valid inventory. The inventory is unknown.',
  timed_out:
    'The local runtime did not finish within the diagnostic limit. The inventory is unknown.',
  unavailable: 'No authenticated desktop inventory source is available in this view.',
} as const

/** A local-only diagnostic action in Workspace details → Connections. */
export function NativeSessionInventoryDiagnostic(props: {
  diagnostics?: NativeSessionInventoryDiagnosticService
  runtimeNodeId: string
  workspaceId: string
}) {
  const [state, setState] = createSignal<DiagnosticState>({ status: 'idle' })
  let activeController: AbortController | undefined
  let observedBindingIdentity = readBindingIdentity()

  function readBindingIdentity(): string | undefined {
    try {
      return props.diagnostics?.scopeIdentity()
    } catch {
      return undefined
    }
  }

  function capturedState() {
    const current = state()
    return current.status === 'captured' ? current : undefined
  }

  function unknownReason() {
    const current = state()
    return current.status === 'unknown' ? current.reason : undefined
  }

  function clearCapture() {
    activeController?.abort()
    activeController = undefined
    setState({ status: 'idle' })
  }

  async function capture() {
    if (!props.diagnostics || state().status === 'capturing') return
    const controller = new AbortController()
    const bindingIdentity = readBindingIdentity()
    activeController = controller
    setState({ status: 'capturing', bindingIdentity })
    try {
      const result = await props.diagnostics.capture({
        runtimeNodeId: props.runtimeNodeId,
        signal: controller.signal,
        workspaceId: props.workspaceId,
      })
      if (activeController !== controller) return
      if (readBindingIdentity() !== bindingIdentity) {
        setState({ status: 'unknown', reason: 'ownership_mismatch' })
      } else if (result.status === 'captured') {
        setState({ status: 'captured', bindingIdentity, section: result.section })
      } else {
        setState(result)
      }
    } catch {
      if (activeController === controller) {
        setState({ status: 'unknown', reason: 'read_failed' })
      }
    } finally {
      if (activeController === controller) activeController = undefined
    }
  }

  function cancel() {
    activeController?.abort()
    activeController = undefined
    setState({ status: 'unknown', reason: 'cancelled' })
  }

  function download() {
    const current = state()
    if (current.status !== 'captured') return
    if (readBindingIdentity() !== current.bindingIdentity) {
      clearCapture()
      return
    }
    const text = JSON.stringify(current.section)
    if (new TextEncoder().encode(text).byteLength > NATIVE_SESSION_INVENTORY_MAX_OUTPUT_BYTES) {
      setState({ status: 'unknown', reason: 'read_failed' })
      return
    }
    savePortableFile('adea-native-session-inventory.json', text)
  }

  createEffect(() => {
    const next = readBindingIdentity()
    if (next === observedBindingIdentity) return
    observedBindingIdentity = next
    clearCapture()
  })

  onCleanup(() => {
    activeController?.abort()
    activeController = undefined
  })

  return (
    <SettingsSection
      title="Native session inventory"
      description="Capture bounded session identity and lifecycle metadata on this desktop. The redacted JSON is downloaded locally and is never uploaded."
      bodyLayout="content"
    >
      <Show
        when={props.diagnostics}
        fallback={
          <EmptyDescription role="status">
            {unknownMessages.unavailable} The inventory is unknown, not empty.
          </EmptyDescription>
        }
      >
        <div class="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={state().status === 'capturing'}
            onClick={() => void capture()}
          >
            Capture local inventory
          </Button>
          <Show when={state().status === 'capturing'}>
            <Button size="sm" variant="outline" onClick={cancel}>
              Cancel capture
            </Button>
          </Show>
          <Show when={state().status === 'captured'}>
            <Button size="sm" variant="outline" onClick={download}>
              Download redacted inventory
            </Button>
          </Show>
        </div>
        <Show when={state().status === 'idle'}>
          <EmptyDescription role="status">
            No inventory has been captured. An unavailable source is reported as unknown.
          </EmptyDescription>
        </Show>
        <Show when={state().status === 'capturing'}>
          <EmptyDescription role="status">
            Reading the signed desktop runtime. This action does not start or resume sessions.
          </EmptyDescription>
        </Show>
        <Show when={capturedState()}>
          {(current) => (
            <EmptyDescription role="status">
              Captured {current().section.records.length} session identities
              {current().section.truncated ? ' (inventory is truncated)' : ''}. No transcript,
              credential, process data, or native path is included.
            </EmptyDescription>
          )}
        </Show>
        <Show when={unknownReason()}>
          {(reason) => (
            <EmptyDescription role="status">{unknownMessages[reason()]}</EmptyDescription>
          )}
        </Show>
      </Show>
    </SettingsSection>
  )
}
