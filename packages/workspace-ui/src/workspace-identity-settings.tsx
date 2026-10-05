import {
  workspaceAccentIds,
  type WorkspaceAccentId,
  type WorkspaceSummary,
  type WorkspaceUpdate,
} from '@adea-ai/types'
import { WorkspaceIdentityMark } from '@adea-ai/app-ui/components/workspace-identity-mark'
import { SettingsRow } from '@adea-ai/ui/components/composites/settings'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Input } from '@adea-ai/ui/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@adea-ai/ui/components/ui/radio-group'
import { createEffect, createSignal, For, Show } from 'solid-js'

const ACCENT_LABELS: Record<WorkspaceAccentId, string> = {
  amber: 'Amber',
  blue: 'Blue',
  cyan: 'Cyan',
  green: 'Green',
  pink: 'Pink',
  violet: 'Violet',
}

/** A single emoji grapheme, or `undefined` for anything else. */
export function emojiLogoValue(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 16) return undefined
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(trimmed)]
  if (graphemes.length !== 1) return undefined
  return /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator})/u.test(trimmed)
    ? trimmed
    : undefined
}

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
  const [emoji, setEmoji] = createSignal(
    props.workspace.logo.kind === 'emoji' ? props.workspace.logo.value : ''
  )
  const [state, setState] = createSignal<SaveState>('idle')
  createEffect(() => {
    setName(props.workspace.name)
    setEmoji(props.workspace.logo.kind === 'emoji' ? props.workspace.logo.value : '')
  })

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
  const commitEmoji = () => {
    const value = emoji().trim()
    if (!value) {
      if (props.workspace.logo.kind !== 'monogram') void save({ logo: { kind: 'monogram' } })
      return
    }
    const valid = emojiLogoValue(value)
    if (!valid) {
      setState('error')
      return
    }
    if (props.workspace.logo.kind !== 'emoji' || props.workspace.logo.value !== valid)
      void save({ logo: { kind: 'emoji', value: valid } })
  }

  const status = () =>
    ({
      idle: '',
      saving: 'Saving…',
      saved: 'Saved.',
      conflict: 'This workspace changed elsewhere. The latest settings are shown; try again.',
      error: 'The change could not be saved. Use one emoji, or clear it to use initials.',
    })[state()]

  return (
    <>
      <SettingsRow label="Name" description="Shown in the sidebar and the top bar.">
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
      <SettingsRow label="Mark" description="One emoji, or leave blank to use the name's initials.">
        <div class="workspace-identity-settings__mark">
          <WorkspaceIdentityMark
            accent={props.workspace.accent}
            logo={props.workspace.logo}
            name={props.workspace.name}
            size="md"
          />
          <Input
            aria-label="Workspace emoji"
            value={emoji()}
            maxLength={16}
            placeholder="Initials"
            disabled={!editable()}
            onInput={(event) => setEmoji(event.currentTarget.value)}
            onBlur={commitEmoji}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
            }}
          />
          <Show when={props.workspace.logo.kind === 'emoji'}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!editable()}
              onClick={() => {
                setEmoji('')
                void save({ logo: { kind: 'monogram' } })
              }}
            >
              Use initials
            </Button>
          </Show>
        </div>
      </SettingsRow>
      <SettingsRow
        label="Accent"
        description="Colours the app while this workspace is active, and its mark everywhere."
      >
        <RadioGroup
          aria-label="Workspace accent"
          value={props.workspace.accent ?? 'theme'}
          disabled={!editable()}
          onChange={(value) =>
            void save({ accent: value === 'theme' ? null : (value as WorkspaceAccentId) })
          }
        >
          <RadioGroupItem value="theme" label="Theme default" />
          <For each={workspaceAccentIds}>
            {(accent) => <RadioGroupItem value={accent} label={ACCENT_LABELS[accent]} />}
          </For>
        </RadioGroup>
      </SettingsRow>
      <SettingsRow label="Virtual world" description="The world the Virtual view opens in.">
        <RadioGroup
          aria-label="Virtual world"
          value={props.workspace.scene}
          disabled={!editable()}
          onChange={(value) => void save({ scene: value === 'work' ? 'work' : 'home' })}
        >
          <RadioGroupItem value="home" label="Home" />
          <RadioGroupItem value="work" label="Work" />
        </RadioGroup>
      </SettingsRow>
      <p class="conventional-settings-note" role="status" aria-live="polite">
        {status()}
      </p>
    </>
  )
}
