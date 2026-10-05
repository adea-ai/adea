import type { Accessor } from 'solid-js'
import { createEffect, createSignal, onCleanup, Show } from 'solid-js'
import { SettingsRow } from '@adea-ai/ui/components/composites/settings'
import { NativeSelect } from '@adea-ai/ui/components/ui/native-select'
import type {
  VersionDialogAdapter,
  VersionDialogChannelActions,
} from '@adea-ai/app-ui/components/version-dialog'
import { noteUpdatePhase } from '@adea-ai/workspace-ui/update-pending'
import type { UpdateChannelSetting, UpdatesService } from '@adea-ai/workspace-ui/platform'
import lazyComponent from './lazy-component'

import {
  checkDesktopUpdate,
  getDesktopUpdateStatus,
  installDesktopUpdate,
  isDesktopRuntime,
  type DesktopUpdate,
} from '../lib/desktop-update'
import { withSyntheticDownloadProgress } from '../lib/desktop-update-progress'
import packageJson from '../../package.json'

const packageVersion = packageJson.version

const SharedVersionDialog = lazyComponent(() =>
  import('@adea-ai/app-ui/components/version-dialog').then((module) => module.VersionDialog)
)

/**
 * Mirror every updater answer into the shared update-pending state the rail
 * and the account menu read for their dot badge. The version dialog owns the
 * only update-checker; mirroring here keeps exactly one source of truth and
 * never issues a second check on its own.
 */
function noteUpdatePending(update: DesktopUpdate): void {
  noteUpdatePhase(update.phase)
}

function mirrorUpdatePending(adapter: VersionDialogAdapter): VersionDialogAdapter {
  return {
    ...adapter,
    check: async () => {
      const update = await adapter.check()
      noteUpdatePending(update)
      return update
    },
    getStatus: async () => {
      const update = await adapter.getStatus()
      noteUpdatePending(update)
      return update
    },
    install: async (expectedVersion) => {
      const update = await adapter.install(expectedVersion)
      noteUpdatePending(update)
      return update
    },
  }
}

const desktopUpdateAdapter: VersionDialogAdapter = mirrorUpdatePending({
  ...withSyntheticDownloadProgress({
    check: checkDesktopUpdate,
    getStatus: getDesktopUpdateStatus,
    install: installDesktopUpdate,
  }),
  isDesktopRuntime,
  // The dialog polls status during a native install; without a poll interval
  // it never learns about progress between install start and end.
  pollIntervalMs: 400,
})

function UpdateChannelControl(props: {
  actions: VersionDialogChannelActions
  service: UpdatesService
  open?: boolean
}) {
  const [channel, setChannel] = createSignal<UpdateChannelSetting>('stable')
  const [state, setState] = createSignal<'error' | 'loading' | 'ready' | 'saving'>('loading')
  const [error, setError] = createSignal<string | null>(null)

  createEffect(() => {
    if (!props.open) return
    let active = true
    setState('loading')
    setError(null)
    void props.service
      .channel()
      .then((value) => {
        if (!active) return
        setChannel(value)
        setState('ready')
      })
      .catch(() => {
        if (!active) return
        setState('error')
        setError('The current update channel could not be read.')
      })
    onCleanup(() => {
      active = false
    })
  })

  const detail = () => {
    switch (channel()) {
      case 'pre-release':
        return 'Daily pre-release builds arrive early, with rough edges included.'
      case 'dev':
        return 'Follows every dev build from main. Intended for development machines.'
      default:
        return 'Tested releases after about four days in pre-release.'
    }
  }

  const saveChannel = async (value: string) => {
    if (state() !== 'ready' || props.actions.disabled()) return
    const previous = channel()
    const next = value as UpdateChannelSetting
    let persisted = false
    setChannel(next)
    setState('saving')
    setError(null)
    try {
      await props.actions.recheck(async () => {
        try {
          await props.service.setChannel(next)
          persisted = true
        } catch (caught) {
          setChannel(previous)
          throw caught
        }
      })
    } catch {
      // The shared dialog renders the recheck failure. Roll back only if the
      // channel write itself failed; a failed feed check keeps the saved choice.
      if (!persisted) setChannel(previous)
    } finally {
      setState('ready')
    }
  }

  return (
    <div class="flex flex-col gap-2">
      <SettingsRow label="Update channel" description={detail()}>
        <NativeSelect
          aria-label="Update channel"
          disabled={state() !== 'ready' || props.actions.disabled()}
          value={channel()}
          onChange={(event) => void saveChannel(event.currentTarget.value)}
          options={[
            { value: 'stable', label: 'Stable' },
            { value: 'pre-release', label: 'Pre-release' },
            { value: 'dev', label: 'Dev' },
          ]}
        />
      </SettingsRow>
      <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>
    </div>
  )
}

export function VersionDialog(props: {
  channelService?: UpdatesService
  onOpenChange?: (open: boolean) => void
  open?: boolean
  restoreFocusRef?: Accessor<HTMLElement | undefined>
}) {
  // Keep the native status/badge probe owned by DesktopWorkspaceEntry. Load
  // the visual updater only once the user opens it, then keep that same
  // mounted component across closes so reopen state and focus behavior match
  // the eagerly-mounted dialog.
  const [hasOpened, setHasOpened] = createSignal(props.open ?? false)
  createEffect(() => {
    if (props.open) setHasOpened(true)
  })

  const channelService = props.channelService
  const channelControl = channelService
    ? (actions: VersionDialogChannelActions) => (
        <UpdateChannelControl actions={actions} open={props.open} service={channelService} />
      )
    : undefined

  return (
    <Show when={hasOpened()}>
      <SharedVersionDialog
        adapter={desktopUpdateAdapter}
        appIcon="/icon.svg"
        channelControl={channelControl}
        fallbackVersion={packageVersion}
        onOpenChange={props.onOpenChange}
        open={props.open}
        restoreFocusRef={props.restoreFocusRef}
      />
    </Show>
  )
}
