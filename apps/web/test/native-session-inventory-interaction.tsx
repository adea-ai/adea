import { createComponent, createSignal } from 'solid-js'
import { render } from 'solid-js/web'

import { NativeSessionInventoryDiagnostic } from '../../../packages/workspace-ui/src/native-session-inventory-diagnostic'

const [bindingIdentity, setBindingIdentity] = createSignal('initial-binding')
let currentSignal: AbortSignal | undefined
let resolveCapture: ((value: unknown) => void) | undefined
let captureCalls = 0

const state = {
  get abortSignal() {
    return currentSignal
  },
  get captureCalls() {
    return captureCalls
  },
  finish(result: unknown) {
    resolveCapture?.(result)
    resolveCapture = undefined
  },
  setBindingIdentity,
}

Object.assign(window, { nativeSessionInventoryTest: state })

const diagnostics = {
  scopeIdentity: bindingIdentity,
  capture(input: Readonly<{ signal?: AbortSignal }>) {
    captureCalls += 1
    currentSignal = input.signal
    return new Promise((resolve) => {
      resolveCapture = resolve
    })
  },
}

render(
  () =>
    createComponent(NativeSessionInventoryDiagnostic, {
      diagnostics,
      workspaceId: '00000000-0000-4000-8000-000000000002',
    }),
  document.querySelector('#root')!
)
