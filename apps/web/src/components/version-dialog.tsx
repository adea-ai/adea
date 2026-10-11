import { createEffect, createSignal, onCleanup, type Accessor } from 'solid-js'
import {
  VersionDialog as SharedVersionDialog,
  type VersionDialogAdapter,
} from '@adea-ai/app-ui/components/version-dialog'

import {
  checkDesktopUpdate,
  getDesktopUpdateStatus,
  installDesktopUpdate,
  isDesktopRuntime,
} from '../lib/desktop-update'
import packageJson from '../../package.json'
import { desktopAppIcon } from '../lib/desktop-app-icon'
import { openAdeaExternalUrl } from '../lib/external-links'
import changelogAsset from '../../../../CHANGELOG.md?url'

const packageVersion = packageJson.version
const changelogLoadFailure =
  'Could not load the installed history. View release history at https://github.com/adea-ai/adea/releases.'
let loadedBrowserChangelog: string | undefined
let browserChangelogRequest: Promise<{ content: string; success: boolean }> | undefined

function loadBrowserChangelog(): Promise<{ content: string; success: boolean }> {
  if (loadedBrowserChangelog !== undefined)
    return Promise.resolve({ content: loadedBrowserChangelog, success: true })
  browserChangelogRequest ??= fetch(changelogAsset)
    .then(async (response) => {
      if (!response.ok) throw new Error('The installed changelog could not be loaded.')
      const content = await response.text()
      loadedBrowserChangelog = content
      return { content, success: true }
    })
    .catch(() => {
      browserChangelogRequest = undefined
      return { content: changelogLoadFailure, success: false }
    })
  return browserChangelogRequest
}

const desktopUpdateAdapter: VersionDialogAdapter = {
  check: checkDesktopUpdate,
  getStatus: getDesktopUpdateStatus,
  install: installDesktopUpdate,
  isDesktopRuntime,
  openExternal: openAdeaExternalUrl,
  pollIntervalMs: 500,
}

export function VersionDialog(props: {
  onOpenChange?: (open: boolean) => void
  open?: boolean
  restoreFocusRef?: Accessor<HTMLElement | undefined>
}) {
  const [browserChangelog, setBrowserChangelog] = createSignal<string>()
  const [browserChangelogFailed, setBrowserChangelogFailed] = createSignal(false)
  let dialogWasOpen = false
  createEffect(() => {
    if (!props.open || isDesktopRuntime()) {
      dialogWasOpen = false
      return
    }
    if (dialogWasOpen) return
    dialogWasOpen = true
    if (browserChangelog() !== undefined && !browserChangelogFailed()) return

    let active = true
    void loadBrowserChangelog().then(({ content, success }) => {
      if (!active) return
      setBrowserChangelog(content)
      setBrowserChangelogFailed(!success)
    })
    onCleanup(() => {
      active = false
    })
  })

  return (
    <SharedVersionDialog
      adapter={desktopUpdateAdapter}
      appIcon={desktopAppIcon}
      changelog={browserChangelog()}
      fallbackVersion={packageVersion}
      onOpenChange={props.onOpenChange}
      open={props.open}
      restoreFocusRef={props.restoreFocusRef}
    />
  )
}
