import {
  workspaceAccentIds,
  type WorkspaceAccentId,
  type WorkspaceSummary,
  type WorkspaceUpdate,
} from '@adea-ai/types'
import { accentPresetById, themeRegistry } from '@adea-ai/app-ui/components/appearance'
import { WorkspaceIdentityMark } from '@adea-ai/app-ui/components/workspace-identity-mark'
import { cn } from '@adea-ai/app-ui/lib/utils'
import { useOptionalTheme } from '@adea-ai/app-ui/components/theme-provider'
import { SettingsRow } from '@adea-ai/ui/components/composites/settings'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Input } from '@adea-ai/ui/components/ui/input'
import { Label } from '@adea-ai/ui/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@adea-ai/ui/components/ui/radio-group'
import type { JSX } from 'solid-js'
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

  const defaultIcon = () => (props.workspace.isPersonal ? ('home' as const) : ('box' as const))
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
      if (props.workspace.logo.kind === 'emoji') void save({ logo: { kind: defaultIcon() } })
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

  // Idle, an editable form says how saving works: there is no Save button.
  const status = () =>
    ({
      idle: editable() ? 'Changes save as you make them.' : '',
      saving: 'Saving…',
      saved: 'Saved.',
      conflict: 'This workspace changed elsewhere. The latest settings are shown; try again.',
      error: 'Could not save. Use one emoji or clear it for the workspace icon.',
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
      <SettingsRow label="Mark" description="One emoji, or blank for the workspace icon.">
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
            placeholder="Workspace icon"
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
                void save({ logo: { kind: defaultIcon() } })
              }}
            >
              Use workspace icon
            </Button>
          </Show>
        </div>
      </SettingsRow>
      <SettingsRow
        label="Accent"
        description="Colours the app while this workspace is active, and its mark everywhere."
      >
        <AccentSwatches
          selected={props.workspace.accent ?? 'theme'}
          disabled={!editable()}
          onSelect={(value) =>
            void save({ accent: value === 'theme' ? null : (value as WorkspaceAccentId) })
          }
        />
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
      <p
        class="conventional-settings-note"
        role="status"
        aria-label="Workspace identity save status"
        aria-live="polite"
      >
        {status()}
      </p>
    </>
  )
}

/**
 * The workspace accent picker, drawn as the same swatch grid the appearance
 * editor's AccentChoices composes from the published RadioGroup primitives:
 * one round swatch per accent painted with the catalogue's light/dark pair
 * value, selection carried by the checked ring. It differs from the global
 * grid in exactly one entry — a leading "Theme default" swatch (the
 * workspace's `null` accent), painted with the inherited primary so it shows
 * the accent the workspace would keep. Keyboard semantics are the
 * RadioGroup's: roving focus, arrow keys, Space to select.
 */
function AccentSwatches(props: {
  selected: string
  disabled?: boolean
  onSelect: (value: string) => void
}) {
  const theme = useOptionalTheme()
  const appearance = (): 'light' | 'dark' => {
    const variant = themeRegistry().find((entry) => entry.id === theme?.variantId())
    return variant?.appearance === 'light' ? 'light' : 'dark'
  }
  const choices = (): { id: string; label: string; fill: JSX.Element }[] => [
    {
      id: 'theme',
      label: 'Theme default',
      fill: <span class="block size-full rounded-full bg-primary" />,
    },
    ...workspaceAccentIds.map((id) => {
      const preset = accentPresetById(id)
      const fill: JSX.Element = preset ? (
        <svg class="size-full" viewBox="0 0 16 16" aria-hidden="true">
          <circle
            cx="8"
            cy="8"
            r="8"
            fill={appearance() === 'light' ? preset.light : preset.dark}
          />
        </svg>
      ) : (
        <span class="block size-full rounded-full bg-muted-foreground/40" />
      )
      return { id, label: ACCENT_LABELS[id], fill }
    }),
  ]
  return (
    <RadioGroup
      aria-label="Workspace accent"
      value={props.selected}
      disabled={props.disabled}
      class="grid-cols-4"
      data-accent-grid=""
      onChange={(value) => props.onSelect(value)}
    >
      <For each={choices()}>
        {(option) => (
          <div class="rounded-full focus-within:ring-3 focus-within:ring-ring/50">
            {/* The card is the control's published Label (associated by the
                deterministic item/input id pair), so clicking anywhere on the
                swatch selects the accent; the hidden radio control keeps the
                group keyboard-driven and the wrapper carries its focus ring. */}
            <RadioGroupItem
              id={`workspace-accent-${option.id}`}
              value={option.id}
              controlClass="sr-only"
            >
              <Label for={`workspace-accent-${option.id}-input`} class="w-full">
                <span
                  class={cn('block size-7 cursor-pointer rounded-full border p-0.5', {
                    'border-primary ring-1 ring-primary': props.selected === option.id,
                  })}
                >
                  {option.fill}
                </span>
                <span class="sr-only">{option.label}</span>
              </Label>
            </RadioGroupItem>
          </div>
        )}
      </For>
    </RadioGroup>
  )
}
