import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'

import {
  VersionDialog,
  type SharedDesktopUpdate,
  type VersionDialogAdapter,
} from '../../../src/components/version-dialog'

const current: SharedDesktopUpdate = {
  available_version: null,
  changelog: 'Installed release history',
  current_version: '0.63.1',
  downloaded_bytes: 0,
  error: null,
  github_url: 'https://github.com/adea-ai/adea/releases',
  phase: 'current',
  release_date: null,
  release_notes: null,
  restart_required: false,
  total_bytes: null,
}

const params = new URL(window.location.href).searchParams
const failure = params.get('failure')
const reload = params.get('reload')
const initial: SharedDesktopUpdate =
  params.get('initial') === 'available'
    ? { ...current, available_version: '0.64.0', phase: 'available' }
    : current
let statusCalls = 0
let failFirstCheck = true
let checkCalls = 0
let rejectManualCheck: ((reason?: unknown) => void) | undefined
const [checkCount, setCheckCount] = createSignal(0)
const [open, setOpen] = createSignal(true)

window.addEventListener('reject-manual-check', () => {
  rejectManualCheck?.(new Error('Late update check failure.'))
})
window.addEventListener('open-version-dialog', () => setOpen(true))

const adapter: VersionDialogAdapter = {
  async getStatus() {
    statusCalls += 1
    if (reload === 'available' && statusCalls > 1) {
      return { ...current, available_version: '0.64.0', phase: 'available' }
    }
    return initial
  },
  async check() {
    checkCalls += 1
    setCheckCount(checkCalls)
    if (failure === 'race') {
      if (checkCalls === 2) {
        return new Promise<SharedDesktopUpdate>((_resolve, reject) => {
          rejectManualCheck = reject
        })
      }
      return current
    }
    const shouldFail = failure === 'manual-structured' ? checkCalls === 2 : failFirstCheck
    if (!shouldFail) return current
    failFirstCheck = false

    switch (failure) {
      case 'error':
        throw new Error('Update feed request timed out.')
      case 'string':
        throw 'The update service could not be reached.'
      case 'structured':
        throw {
          safe: { message: 'The update feed is temporarily unavailable.' },
          accessToken: 'test-token-must-not-render',
        }
      case 'manual-structured':
        throw { safe: { message: 'The update feed is temporarily unavailable.' } }
      case 'unknown':
        throw { code: 'UPDATE_UNAVAILABLE', accessToken: 'test-token-must-not-render' }
      case 'unsafe-message':
        throw { message: 'test-token-must-not-render', accessToken: 'not-safe' }
      case 'unsafe-nested-message':
        throw { error: { message: 'test-token-must-not-render' } }
      case 'failed-status':
        return { ...current, phase: 'failed', error: '[object Object]' }
      default:
        return current
    }
  },
  async install(version) {
    return { ...current, current_version: version, phase: 'installed' }
  },
  isDesktopRuntime() {
    return true
  },
}

render(
  () => (
    <>
      <output data-testid="check-count">{checkCount()}</output>
      <VersionDialog
        adapter={adapter}
        fallbackVersion="0.63.1"
        open={open()}
        onOpenChange={setOpen}
      />
    </>
  ),
  document.getElementById('app')!
)
