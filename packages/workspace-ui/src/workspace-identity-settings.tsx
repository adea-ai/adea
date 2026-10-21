import { isWorkspaceAccent, type WorkspaceSummary, type WorkspaceUpdate } from '@adea-ai/types'
import { WorkspaceIdentityMark } from '@adea-ai/app-ui/components/workspace-identity-mark'
import { AccentPicker } from '@adea-ai/ui/components/composites/accent-picker'
import { SettingsRow } from '@adea-ai/ui/components/composites/settings'
import { IconPickerDropdown, isShellIconKey } from '@adea-ai/ui/components/composites/icon-picker'
import { Input } from '@adea-ai/ui/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@adea-ai/ui/components/ui/toggle-group'
import { Text } from '@adea-ai/ui/components/ui/typography'
import { createEffect, createSignal } from 'solid-js'

type SaveState = 'idle' | 'saving' | 'saved' | 'conflict' | 'error'

/**
 * The workspace's own identity: name, mark, accent and Virtual world. Each
 * change saves immediately against the summary's version; a stale version is
 * reported rather than overwritten, and the host's refetch brings the latest.
 */
export function WorkspaceIdentitySettings(props: {
  onUpdate?: (update: WorkspaceUpdate & Readonly<{ expectedVersion: number }>) => Promise<void>
  workspace: WorkspaceSummary
}) {
  const [name, setName] = createSignal(props.workspace.name)
  const [state, setState] = createSignal<SaveState>('idle')
  createEffect(() => setName(props.workspace.name))

  const defaultIcon = () => (props.workspace.isPersonal ? ('home' as const) : ('box' as const))
  // The picker shows the stored icon key; an unrecognised key (or an emoji set
  // before the dropdown existed) checks nothing rather than a wrong glyph.
  const pickedIconKey = () => {
    const logo = props.workspace.logo
    if (logo.kind === 'icon') return isShellIconKey(logo.value) ? logo.value : undefined
    if (logo.kind === 'home' || logo.kind === 'box') return logo.kind
    return undefined
  }
  const editable = () => Boolean(props.onUpdate)
  const save = async (update: WorkspaceUpdate) => {
    if (!props.onUpdate) return
    setState('saving')
    try {
      await props.onUpdate({ ...update, expectedVersion: props.workspace.version })
      setState('saved')
    } catch (error) {
      setState(
        error instanceof Error && /version conflict/i.test(error.message) ? 'conflict' : 'error'
      )
    }
  }
  const commitName = () => {
    const next = name().trim()
    if (!next) {
      setName(props.workspace.name)
      return
    }
    if (next !== props.workspace.name) void save({ name: next })
  }

  const status = () =>
    ({
      idle: editable() ? 'Changes save as you make them.' : '',
      saving: 'Saving…',
      saved: 'Saved.',
      conflict: 'This workspace changed elsewhere. The latest settings are shown; try again.',
      error: 'Could not save.',
    })[state()]

  return (
    <>
      <SettingsRow label="Name" help="Shown in the sidebar and the top bar.">
        <Input
          aria-label="Workspace name"
          value={name()}
          maxLength={80}
          disabled={!editable()}
          onInput={(event) => setName(event.currentTarget.value)}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') {
              setName(props.workspace.name)
              event.currentTarget.blur()
            }
          }}
        />
      </SettingsRow>
      <SettingsRow label="Icon">
        <IconPickerDropdown
          label="Workspace icon"
          value={pickedIconKey()}
          defaultKey={defaultIcon()}
          disabled={!editable()}
          trigger={
            <WorkspaceIdentityMark
              accent={props.workspace.accent}
              logo={props.workspace.logo}
              name={props.workspace.name}
              size="md"
            />
          }
          onValueChange={(key) =>
            void save({
              logo: key === defaultIcon() ? { kind: defaultIcon() } : { kind: 'icon', value: key },
            })
          }
          image={props.workspace.logo.kind === 'image' ? props.workspace.logo.value : undefined}
          onImageChange={(image) =>
            void save({
              logo: image ? { kind: 'image', value: image } : { kind: defaultIcon() },
            })
          }
        />
      </SettingsRow>
      <SettingsRow label="Accent" help="Colours the app while this workspace is active.">
        <AccentPicker
          label="Workspace accent"
          inheritLabel="Inherit (default)"
          value={props.workspace.accent ?? null}
          disabled={!editable()}
          onValueChange={(value) =>
            void save({ accent: value && isWorkspaceAccent(value) ? value : null })
          }
        />
      </SettingsRow>
      <SettingsRow label="Virtual world" help="The world the Virtual view opens in.">
        <ToggleGroup
          aria-label="Virtual world"
          value={props.workspace.scene}
          disabled={!editable()}
          onChange={(value: string | null) => {
            if (value === 'home' || value === 'work') void save({ scene: value })
          }}
        >
          <ToggleGroupItem value="home">Home</ToggleGroupItem>
          <ToggleGroupItem value="work">Work</ToggleGroupItem>
        </ToggleGroup>
      </SettingsRow>
      <Text
        variant="caption"
        tone="muted"
        class="mt-4"
        role="status"
        aria-label="Workspace identity save status"
        aria-live="polite"
      >
        {status()}
      </Text>
    </>
  )
}
