import { type DevErrorCode, type Scope, type TerminalRecord } from '@adea-ai/types/dev-runtime'
import { Show, Suspense, createEffect, createMemo, createSignal, lazy, onCleanup } from 'solid-js'
import { Button } from '@adea-ai/ui/components/ui/button'

import type { DevRuntimeService } from '../platform'
import { createTerminalRuntimeConnection } from './runtime-connection'
import { resolveSelectedTerminal } from './selected-terminal'

const TerminalPane = lazy(() =>
  import('./terminal-pane').then((module) => ({ default: module.TerminalPane }))
)

type RuntimeTerminalState =
  | Readonly<{ status: 'loading' }>
  | Readonly<{
      status: 'unavailable'
      reason: DevErrorCode
      message: string
      retryable: boolean
    }>
  | Readonly<{
      status: 'ready'
      terminal: TerminalRecord
      connect: ReturnType<typeof createTerminalRuntimeConnection>['connect']
    }>

export type RuntimeTerminalPaneProps = Readonly<{
  runtime: DevRuntimeService
  scope: Scope
  runtimeSessionId: string
  worktreeId: string
  /** Missing for an unbound split leaf; the primary is resolved by the caller. */
  terminalId?: string
  worktreeLabel?: string
  capabilityStatus: 'loading' | 'ready' | 'unavailable'
  canAttach?: boolean
  canInput?: boolean
  canManage?: boolean
}>

function messageFor(reason: DevErrorCode): string {
  switch (reason) {
    case 'not_found':
      return 'No terminal is selected for this pane.'
    case 'unavailable':
    case 'capability_unavailable':
    case 'capability_denied':
    case 'permission_denied':
      return 'The selected terminal is unavailable for this runtime.'
    default:
      return 'The selected terminal could not be verified for this session.'
  }
}

export function RuntimeTerminalPane(props: RuntimeTerminalPaneProps) {
  const [state, setState] = createSignal<RuntimeTerminalState>({ status: 'loading' })
  const [retrySequence, setRetrySequence] = createSignal(0)
  const request = createMemo(
    () => ({
      runtime: props.runtime,
      scope: props.scope,
      runtimeSessionId: props.runtimeSessionId,
      worktreeId: props.worktreeId,
      terminalId: props.terminalId,
      capabilityStatus: props.capabilityStatus,
      canAttach: props.canAttach,
      canInput: props.canInput,
    }),
    undefined,
    {
      equals: (previous, next) =>
        previous.runtime === next.runtime &&
        previous.scope.accountId === next.scope.accountId &&
        previous.scope.workspaceId === next.scope.workspaceId &&
        previous.scope.runtimeNodeId === next.scope.runtimeNodeId &&
        previous.runtimeSessionId === next.runtimeSessionId &&
        previous.worktreeId === next.worktreeId &&
        previous.terminalId === next.terminalId &&
        previous.capabilityStatus === next.capabilityStatus &&
        previous.canAttach === next.canAttach &&
        previous.canInput === next.canInput,
    }
  )
  const readyState = createMemo(() => {
    const current = state()
    return current.status === 'ready' ? current : undefined
  })
  const fallbackMessage = () => {
    const current = state()
    return current.status === 'loading'
      ? 'Connecting to the selected terminal…'
      : current.status === 'unavailable'
        ? current.message
        : ''
  }
  const retryable = () => {
    const current = state()
    return current.status === 'unavailable' && current.retryable
  }

  createEffect(() => {
    const {
      runtime,
      scope,
      runtimeSessionId,
      worktreeId,
      terminalId,
      capabilityStatus,
      canAttach,
      canInput,
    } = request()
    retrySequence()
    if (capabilityStatus === 'loading') {
      setState({ status: 'loading' })
      return
    }
    if (capabilityStatus !== 'ready') {
      setState({
        status: 'unavailable',
        reason: 'capability_unavailable',
        message: 'Terminal permissions could not be verified.',
        retryable: false,
      })
      return
    }
    if (canAttach !== true) {
      setState({
        status: 'unavailable',
        reason: 'capability_denied',
        message: 'Terminal attachment is unavailable for this runtime.',
        retryable: false,
      })
      return
    }
    if (canInput !== true) {
      setState({
        status: 'unavailable',
        reason: 'capability_denied',
        message: 'Terminal input is unavailable for this runtime.',
        retryable: false,
      })
      return
    }
    if (!terminalId) {
      setState({
        status: 'unavailable',
        reason: 'not_found',
        message: messageFor('not_found'),
        retryable: false,
      })
      return
    }

    const controller = new AbortController()
    onCleanup(() => controller.abort())
    setState({ status: 'loading' })
    void resolveSelectedTerminal({
      execute: (command) => runtime.execute(command),
      scope,
      selection: { runtimeSessionId, worktreeId, terminalId },
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return
        if (result.status !== 'ready') {
          setState({
            ...result,
            message: messageFor(result.reason),
            retryable: true,
          })
          return
        }
        setState({
          status: 'ready',
          terminal: result.terminal,
          connect: createTerminalRuntimeConnection({
            runtime,
            terminal: result.terminal,
          }).connect,
        })
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setState({
          status: 'unavailable',
          reason: 'unavailable',
          message: 'The selected terminal could not be checked. Try again.',
          retryable: true,
        })
      })
  })

  return (
    <Show
      when={readyState()}
      fallback={
        <div class="dev-pane-state__line" data-state={state().status}>
          <span role="status">{fallbackMessage()}</span>
          <Show when={retryable()}>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setRetrySequence((sequence) => sequence + 1)}
            >
              Retry terminal
            </Button>
          </Show>
        </div>
      }
    >
      {(ready) => (
        <Suspense
          fallback={
            <p class="dev-pane-state__line" role="status" data-state="loading">
              Loading terminal…
            </p>
          }
        >
          <TerminalPane
            connect={ready().connect}
            fromSequence="0"
            heartbeatMode="server_only"
            resizeEnabled={props.canManage === true}
            worktreeId={ready().terminal.worktreeId}
            worktreeLabel={props.worktreeLabel}
          />
        </Suspense>
      )}
    </Show>
  )
}
