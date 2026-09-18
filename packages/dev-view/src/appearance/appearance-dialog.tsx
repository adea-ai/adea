/*
 * Copyright (c) 2026 Wing
 *
 * Live appearance editing is substantially translated from Zeron
 * crates/ui/src/appearance.rs, revision
 * 30a9a9537c5ec96226c87f4bf349b6f77c5dfb59: a system/light/dark segmented
 * control, independent light and dark theme pickers with preview swatches, an
 * accent row, a surface row, and immediate live resolution of every change.
 * Modified for Adea's token layer and the explicit save/revert contract:
 * changes preview against the visible app the moment they are made, while
 * Cancel, Escape, and outside dismissal restore the pre-open snapshot and
 * only Save persists. The custom accent validation and the reduced-
 * transparency surface policy are Adea additions the donor lacks.
 * See NOTICE and docs/research/dev-view-donor-audit.md.
 */
import { Button } from '@adea-ai/ui/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@adea-ai/ui/components/ui/dialog'
import { Input } from '@adea-ai/ui/components/ui/input'
import { Switch } from '@adea-ai/ui/components/ui/switch'
import { ColorSwatch, ThemeSwatch } from '@adea-ai/ui/components/theme-swatch'
import {
  accentPresets,
  builtinThemeRegistry,
  deriveAccentRoles,
  normalizeAccentValue,
  type AppearanceMode,
  type SurfacePreference,
  type ThemeVariant,
} from '@adea-ai/ui/components/appearance'
import { useTheme } from '@adea-ai/ui/components/theme-provider'
import { cn } from '@adea-ai/ui/lib/utils'
import { For, untrack, createEffect, createMemo, createSignal, Show, type JSX } from 'solid-js'

import { createAppearanceEditor } from './editor'

const modeOptions: readonly { value: AppearanceMode; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

const surfaceOptions: readonly { value: SurfacePreference; label: string; hint: string }[] = [
  { value: 'opaque', label: 'Opaque', hint: 'Solid surfaces everywhere.' },
  { value: 'frosted', label: 'Frosted', hint: 'Slightly translucent window surfaces.' },
  {
    value: 'translucent',
    label: 'Translucent',
    hint: 'Native window vibrancy where the platform supports it; tokenized frost elsewhere.',
  },
]

const variantsFor = (appearance: 'light' | 'dark'): readonly ThemeVariant[] =>
  builtinThemeRegistry.filter((variant) => variant.appearance === appearance)

/*
 * Option arrays are module constants: Solid's `For` compares item references,
 * so rebuilding the arrays per render would remount every row (and drop
 * keyboard focus) whenever the draft changes.
 */
const themeOptionsFor = (appearance: 'light' | 'dark') =>
  variantsFor(appearance).map((variant) => ({
    value: variant.id,
    label: variant.name,
    content: (
      <>
        <ThemeSwatch variant={variant} />
        <span class="grow">{variant.name}</span>
      </>
    ),
  }))

const lightThemeOptions = themeOptionsFor('light')
const darkThemeOptions = themeOptionsFor('dark')

const surfaceRadioOptions = surfaceOptions.map((option) => ({
  value: option.value,
  label: option.label,
  content: (
    <span class="grow">
      {option.label}
      <span class="text-muted-foreground block text-xs">{option.hint}</span>
    </span>
  ),
}))

/**
 * The repository's segmented radiogroup pattern (see ThemeToggle): real
 * buttons with `radio` semantics and roving tabindex, so pointer clicks,
 * arrow keys, and assistive technology all reach the same control.
 */
function AppearanceRadioGroup<T extends string>(props: {
  ariaLabel: string
  class?: string
  optionClass?: string
  options: readonly { value: T; label: string; content?: JSX.Element }[]
  value: T
  onChange: (value: T) => void
}) {
  const [group, setGroup] = createSignal<HTMLDivElement>()
  const focusOption = (index: number) => {
    const target = group()?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[index]
    if (!target) return
    target.focus()
    target.click()
  }
  const onKeyDown = (event: KeyboardEvent) => {
    const currentIndex = props.options.findIndex((option) => option.value === props.value)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? props.options.length - 1
          : event.key === 'ArrowDown' || event.key === 'ArrowRight'
            ? (currentIndex + 1) % props.options.length
            : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
              ? (currentIndex - 1 + props.options.length) % props.options.length
              : -1
    if (next < 0) return
    event.preventDefault()
    focusOption(next)
  }
  return (
    <div
      ref={setGroup}
      class={cn('grid gap-2', props.class)}
      role="radiogroup"
      aria-label={props.ariaLabel}
      onKeyDown={onKeyDown}
    >
      <For each={props.options}>
        {(option) => {
          const checked = () => props.value === option.value
          return (
            <button
              type="button"
              role="radio"
              aria-checked={checked()}
              tabIndex={checked() ? 0 : -1}
              class={cn(
                'flex items-center gap-3 rounded-lg border p-2 text-left text-sm',
                props.optionClass,
                { 'border-primary': checked() }
              )}
              onClick={() => props.onChange(option.value)}
            >
              {option.content ?? option.label}
            </button>
          )
        }}
      </For>
    </div>
  )
}

export function AppearanceDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const appearance = useTheme()
  const editor = createAppearanceEditor()
  const [customAccent, setCustomAccent] = createSignal('')
  const [accentStatus, setAccentStatus] = createSignal('')
  let committing = false

  /*
   * Snapshot the committed preferences on open. The editor reads are
   * untracked: this effect must depend on the committed preferences (and
   * `open`) only — otherwise a draft write would re-run it and immediately
   * reset the draft the user is editing.
   */
  createEffect(() => {
    if (!props.open) return
    const committed = appearance.preferences()
    untrack(() => {
      editor.open(committed)
      setCustomAccent(editor.draft().accent === 'theme' ? '' : editor.draft().accent)
      setAccentStatus('')
    })
  })

  const applyDraft = () => appearance.preview(editor.draft())
  const setDraft = (patch: Parameters<typeof editor.set>[0]) => {
    editor.set(patch)
    applyDraft()
  }

  /** Escape and outside dismissal revert: closing without Save never keeps a draft. */
  const requestClose = () => {
    if (committing) {
      committing = false
      props.onOpenChange(false)
      return
    }
    appearance.preview(undefined)
    editor.revert()
    props.onOpenChange(false)
  }

  const save = () => {
    committing = true
    const committed = editor.save()
    appearance.update({
      mode: committed.mode,
      lightThemeId: committed.lightThemeId,
      darkThemeId: committed.darkThemeId,
      accent: committed.accent,
      surface: committed.surface,
      reduceTransparency: committed.reduceTransparency,
    })
    appearance.preview(undefined)
    props.onOpenChange(false)
  }

  const reset = () => {
    editor.reset()
    setCustomAccent('')
    setAccentStatus('')
    applyDraft()
  }

  const activeVariant = (): ThemeVariant =>
    builtinThemeRegistry.find((candidate) => candidate.id === appearance.variantId()) ??
    builtinThemeRegistry[0]!

  const applyCustomAccent = (value: string) => {
    const normalized = normalizeAccentValue(value, activeVariant().colors.background)
    if (normalized === undefined) {
      // Unparseable input is rejected; the previous accent stays active.
      setAccentStatus(`“${value}” is not a hex color such as #2563eb.`)
      return
    }
    setAccentStatus('')
    setCustomAccent(normalized)
    setDraft({ accent: normalized })
  }

  const accentSelection = () => {
    const accent = editor.draft().accent
    return accent === 'theme' || accentPresets.some((preset) => preset.id === accent)
      ? accent
      : 'custom'
  }

  /*
   * Accent swatches preview against the active variant, so this array is
   * reactive on the variant only: editing the accent, mode, or theme draft
   * keeps the same option objects and never remounts (or unfocuses) the row.
   */
  const accentOptions = createMemo(() => {
    const variant = activeVariant()
    return [
      { value: 'theme', label: 'Theme' },
      ...accentPresets.map((preset) => ({
        value: preset.id,
        label: preset.label,
        content: (
          <>
            <ColorSwatch
              color={deriveAccentRoles(preset.id, variant).primary}
              label={`${preset.label} accent preview`}
            />
            <span class="sr-only">{preset.label}</span>
          </>
        ),
      })),
      { value: 'custom', label: 'Custom' },
    ]
  })

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && requestClose()}>
      <DialogContent class="max-w-md" aria-describedby="appearance-description">
        <DialogHeader>
          <DialogTitle>Appearance</DialogTitle>
          <DialogDescription id="appearance-description">
            Changes preview immediately. Save keeps them; closing without saving restores your
            previous appearance.
          </DialogDescription>
        </DialogHeader>
        <div class="grid gap-6 overflow-y-auto px-6 py-5">
          <section class="grid gap-2" aria-label="Appearance mode">
            <h3 class="text-sm font-medium">Mode</h3>
            <AppearanceRadioGroup
              ariaLabel="Appearance mode"
              class="grid-flow-col justify-stretch"
              optionClass="justify-center"
              options={modeOptions}
              value={editor.draft().mode}
              onChange={(mode) => setDraft({ mode })}
            />
            <p class="text-muted-foreground text-xs">
              System follows your platform appearance live; Light and Dark pin the choice.
            </p>
          </section>

          <section class="grid gap-2" aria-label="Light theme">
            <h3 class="text-sm font-medium">Light theme</h3>
            <AppearanceRadioGroup
              ariaLabel="Light theme"
              options={lightThemeOptions}
              value={editor.draft().lightThemeId}
              onChange={(lightThemeId) => setDraft({ lightThemeId })}
            />
          </section>

          <section class="grid gap-2" aria-label="Dark theme">
            <h3 class="text-sm font-medium">Dark theme</h3>
            <AppearanceRadioGroup
              ariaLabel="Dark theme"
              options={darkThemeOptions}
              value={editor.draft().darkThemeId}
              onChange={(darkThemeId) => setDraft({ darkThemeId })}
            />
          </section>

          <section class="grid gap-2" aria-label="Accent color">
            <h3 class="text-sm font-medium">Accent</h3>
            <AppearanceRadioGroup
              ariaLabel="Accent color"
              class="grid-flow-col justify-stretch"
              options={accentOptions()}
              value={accentSelection()}
              onChange={(value) => {
                if (value === 'custom') {
                  applyCustomAccent(customAccent() || '#2563eb')
                  return
                }
                setDraft({ accent: value })
              }}
            />
            <label class="flex items-center gap-2 text-sm">
              <span class="text-muted-foreground">Custom hex</span>
              <Input
                type="text"
                class="max-w-40"
                aria-label="Custom accent color as a hex value"
                placeholder="#2563eb"
                value={customAccent()}
                onChange={(event) => applyCustomAccent(event.currentTarget.value.trim())}
              />
            </label>
            <p class="text-muted-foreground text-xs" role="status">
              {accentStatus() ||
                'Accents stay accessible: colors below the contrast minimum are normalized.'}
            </p>
          </section>

          <section class="grid gap-2" aria-label="Surface">
            <h3 class="text-sm font-medium">Surface</h3>
            <AppearanceRadioGroup
              ariaLabel="Surface"
              options={surfaceRadioOptions}
              value={editor.draft().surface}
              onChange={(surface) => setDraft({ surface })}
            />
            <div class="flex items-center gap-2 text-sm">
              <Switch
                checked={editor.draft().reduceTransparency}
                onChange={(reduceTransparency) => setDraft({ reduceTransparency })}
                aria-label="Reduce transparency"
              />
              Reduce transparency
            </div>
            <p class="text-muted-foreground text-xs" role="status" aria-live="polite">
              <Show
                when={appearance.reduceTransparencyActive() || editor.draft().reduceTransparency}
                fallback="Frosted and translucent surfaces keep core text at full contrast."
              >
                Reduced transparency is active: opaque surfaces are forced for readability.
              </Show>
            </p>
          </section>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={reset}>
            Reset
          </Button>
          <Button type="button" variant="outline" onClick={requestClose}>
            Cancel
          </Button>
          <Button type="button" onClick={save}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
