/*
 * Copyright (c) 2026 Wing
 *
 * Live appearance editing is substantially translated from Zeron
 * crates/ui/src/appearance.rs and — for the page composition this dialog
 * ports — crates/ui/src/settings/appearance.rs with the option-card and
 * card-row scaffolding of crates/ui/src/settings/widgets.rs, revision
 * 30a9a9537c5ec96226c87f4bf349b6f77c5dfb59: three live mode mini-preview
 * cards (System renders the split light/dark miniature), independent light
 * and dark theme rows with compact palette-preview dropdowns, an accent row
 * of "Theme default" plus preset swatch circles over its helper copy, a
 * segmented glass control with per-selection helper copy, and a theme
 * library row behind the declared-license contract. Modified for Adea's
 * token layer, the explicit save/revert contract (changes preview against
 * the visible app the moment they are made, while Cancel, Escape, and
 * outside dismissal restore the pre-open snapshot and only Save persists),
 * the validated custom accent, and the reduced-transparency policy the
 * donor lacks. The donor's ThemeDefault glass pole has no Adea model value;
 * the translucent slot carries that end of the control.
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@adea-ai/ui/components/ui/dropdown-menu'
import { Input } from '@adea-ai/ui/components/ui/input'
import { Switch } from '@adea-ai/ui/components/ui/switch'
import { ColorSwatch } from '@adea-ai/ui/components/theme-swatch'
import {
  AccentDefaultSample,
  PalettePreview,
  ThemeMiniature,
  ThemeMiniatureSplit,
} from '@adea-ai/ui/components/theme-preview'
import {
  accentPresets,
  builtinThemeRegistry,
  deriveAccentRoles,
  normalizeAccentValue,
  type AppearanceMode,
  type ThemeVariant,
} from '@adea-ai/ui/components/appearance'
import { useTheme } from '@adea-ai/ui/components/theme-provider'
import { cn } from '@adea-ai/ui/lib/utils'
import { ChevronsUpDown, EyeOff, FolderOpen, PanelsTopLeft, SlidersHorizontal } from 'lucide-solid'
import { For, untrack, createEffect, createMemo, createSignal, Show, type JSX } from 'solid-js'

import { createAppearanceEditor } from './editor'
import {
  accentHelperText,
  accentSwatchSelection,
  draftVariants,
  modeCards,
  surfaceChoices,
  surfaceHelperText,
} from './composition'

/*
 * Option arrays are module constants: Solid's `For` compares item references,
 * so rebuilding the arrays per render would remount every row (and drop
 * keyboard focus) whenever the draft changes.
 */
const lightThemeVariants = builtinThemeRegistry.filter((variant) => variant.appearance === 'light')

/** The standing note for the accent row's status line (Adea's contrast policy). */
const ACCENT_NORMALIZATION_NOTE = 'Colors below the contrast minimum are normalized.'
const darkThemeVariants = builtinThemeRegistry.filter((variant) => variant.appearance === 'dark')

type AccentChoice = { value: string; label: string; color?: string }

const accentChipClass = (selected: boolean) =>
  cn(
    'flex size-7 items-center justify-center rounded-lg border p-0.5',
    selected ? 'border-foreground/50' : 'border-border'
  )

/**
 * The repository's segmented radiogroup pattern (see ThemeToggle): real
 * buttons with `radio` semantics and roving tabindex, so pointer clicks,
 * arrow keys, and assistive technology all reach the same control. The group
 * owns the semantics and the keyboard model; each option owns its visuals
 * through `content(selected)`.
 */
function AppearanceRadioGroup<T extends string>(props: {
  ariaLabel: string
  class?: string
  optionClass?: string
  options: readonly { value: T; label: string; content: (selected: boolean) => JSX.Element }[]
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
      class={cn('flex', props.class)}
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
              aria-label={option.label}
              tabIndex={checked() ? 0 : -1}
              class={cn(
                'cursor-pointer rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                props.optionClass
              )}
              onClick={() => props.onChange(option.value)}
            >
              {option.content(checked())}
            </button>
          )
        }}
      </For>
    </div>
  )
}

/**
 * One divided settings row (Zeron `card_row` + `row_tile`/`row_title`/
 * `meta_line`): identity tile, title over a quiet meta line, and the row's
 * control on the right.
 */
function SettingsRow(props: {
  icon: JSX.Element
  title: string
  meta?: JSX.Element
  control: JSX.Element
}) {
  return (
    <div class="flex items-center gap-3.5 px-5 py-3.5">
      <span
        class="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-foreground/5 text-muted-foreground [&_svg]:size-4"
        aria-hidden="true"
      >
        {props.icon}
      </span>
      <span class="min-w-0 flex-1">
        <span class="block truncate text-sm font-medium">{props.title}</span>
        <Show when={props.meta}>
          <span class="text-muted-foreground/65 mt-0.5 flex flex-wrap items-center text-xs">
            {props.meta}
          </span>
        </Show>
      </span>
      {props.control}
    </div>
  )
}

/** A theme picker row's dropdown (Zeron `render_theme_selector`): a compact
 * trigger with the palette strip and theme name over a radio menu. */
function ThemeDropdown(props: {
  ariaLabel: string
  heading: string
  variants: readonly ThemeVariant[]
  value: string
  onChange: (themeId: string) => void
}) {
  const selected = () =>
    props.variants.find((variant) => variant.id === props.value) ?? props.variants[0]!
  return (
    // Non-modal: the portaled menu would otherwise register Kobalte's
    // modal layer against the dialog hosting it.
    <DropdownMenu modal={false} gutter={8}>
      {/* The polymorphic trigger carries the Button outline variant; class
          stays layout-only per the design-system contract. */}
      <DropdownMenuTrigger
        as={Button}
        variant="outline"
        size="sm"
        class="w-56 justify-between"
        aria-label={props.ariaLabel}
      >
        <span class="flex min-w-0 items-center gap-2">
          <PalettePreview variant={selected()} />
          <span class="min-w-0 flex-1 truncate text-xs font-medium">{selected().name}</span>
        </span>
        <ChevronsUpDown class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent class="w-65" align="start">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{props.heading}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={props.value}
            onChange={(value) => props.onChange(String(value))}
          >
            <For each={props.variants}>
              {(variant) => (
                <DropdownMenuRadioItem value={variant.id}>
                  <PalettePreview variant={variant} />
                  <span class="min-w-0 flex-1 truncate">{variant.name}</span>
                </DropdownMenuRadioItem>
              )}
            </For>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function AppearanceDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const appearance = useTheme()
  const editor = createAppearanceEditor()
  const [customAccent, setCustomAccent] = createSignal('')
  const [accentStatus, setAccentStatus] = createSignal('')
  const [libraryOpen, setLibraryOpen] = createSignal(false)
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
      setLibraryOpen(false)
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
    setLibraryOpen(false)
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

  const miniatures = createMemo(() => draftVariants(editor.draft()))

  /*
   * The variant the accent samples preview against, following the draft's
   * mode. In System mode the live document carries the resolved appearance
   * (the preview applies it on every draft change), so the dark class is
   * read untracked rather than re-derived from the committed preference.
   */
  const sampleVariant = () => {
    const variants = miniatures()
    const mode = editor.draft().mode
    if (mode === 'light') return variants.light
    if (mode === 'dark') return variants.dark
    return untrack(() => document.documentElement.classList.contains('dark'))
      ? variants.dark
      : variants.light
  }

  const applyCustomAccent = (value: string) => {
    const normalized = normalizeAccentValue(value, sampleVariant().colors.background)
    if (normalized === undefined) {
      // Unparseable input is rejected; the previous accent stays active.
      setAccentStatus(`“${value}” is not a hex color such as #2563eb.`)
      return
    }
    setAccentStatus('')
    setCustomAccent(normalized)
    setDraft({ accent: normalized })
  }

  const accentSelection = () => accentSwatchSelection(editor.draft().accent)

  /*
   * Accent swatches preview against the active variant, so this array is
   * reactive on the variant only: editing the accent, mode, or theme draft
   * keeps the same option objects and never remounts (or unfocuses) the row.
   */
  const accentChoices = createMemo<readonly AccentChoice[]>(() => [
    { value: 'theme', label: 'Theme default' },
    ...accentPresets.map((preset) => ({
      value: preset.id,
      label: preset.label,
      color: deriveAccentRoles(preset.id, sampleVariant()).primary,
    })),
    { value: 'custom', label: 'Custom' },
  ])

  const miniatureFor = (mode: AppearanceMode) => {
    const variants = miniatures()
    if (mode === 'system')
      return <ThemeMiniatureSplit light={variants.light} dark={variants.dark} />
    if (mode === 'light') return <ThemeMiniature variant={variants.light} />
    return <ThemeMiniature variant={variants.dark} />
  }

  const reduceTransparencyForced = () =>
    appearance.reduceTransparencyActive() || editor.draft().reduceTransparency

  /*
   * The theme library entry point (donor "Add a theme"). Import executes
   * only behind the declared-license contract — an explicit license and
   * provenance are required, never inferred — and activates with the signed
   * App Library pipeline, so M12 ships the built-in set and this dialog says
   * so rather than faking an import. The contract view replaces the
   * appearance dialog instead of nesting a second one: a portaled dialog
   * over a non-modal Kobalte dialog reads as focus-outside and dismisses
   * the host. The draft lives in this component, so returning from the
   * contract view keeps every unsaved edit.
   */
  return (
    <Show
      when={libraryOpen()}
      fallback={
        <Dialog open={props.open} onOpenChange={(open) => !open && requestClose()}>
          <DialogContent class="max-w-xl" aria-describedby="appearance-description">
            <DialogHeader>
              <DialogTitle>Appearance</DialogTitle>
              <DialogDescription id="appearance-description">
                Changes preview immediately. Save keeps them; closing without saving restores your
                previous appearance.
              </DialogDescription>
            </DialogHeader>
            <div class="grid gap-5 overflow-y-auto px-6 py-5">
              <section class="grid gap-2.5" aria-label="Appearance mode">
                <h3 class="text-sm font-medium">Appearance</h3>
                <AppearanceRadioGroup
                  ariaLabel="Appearance mode"
                  class="items-start gap-4"
                  optionClass="min-w-0 flex-1"
                  options={modeCards.map((card) => ({
                    value: card.value,
                    label: card.label,
                    content: (selected: boolean) => (
                      <>
                        <span
                          class={cn(
                            'block h-37 w-full overflow-hidden rounded-md border bg-card',
                            selected ? 'border-primary' : 'border-border'
                          )}
                        >
                          {miniatureFor(card.value)}
                        </span>
                        <span
                          class={cn(
                            'block text-sm',
                            selected ? 'font-medium text-primary' : 'text-muted-foreground'
                          )}
                        >
                          {card.label}
                        </span>
                      </>
                    ),
                  }))}
                  value={editor.draft().mode}
                  onChange={(mode) => setDraft({ mode })}
                />
                <p class="text-muted-foreground text-xs">
                  System follows your platform appearance live; Light and Dark pin the choice.
                </p>
              </section>

              <div class="overflow-hidden rounded-xl border bg-card">
                <div class="divide-y">
                  <section aria-label="Light theme">
                    <SettingsRow
                      icon={<SlidersHorizontal />}
                      title="Light theme"
                      meta="Used whenever this appearance is active."
                      control={
                        <ThemeDropdown
                          ariaLabel="Light theme"
                          heading="Light themes"
                          variants={lightThemeVariants}
                          value={editor.draft().lightThemeId}
                          onChange={(lightThemeId) => setDraft({ lightThemeId })}
                        />
                      }
                    />
                  </section>
                  <section aria-label="Dark theme">
                    <SettingsRow
                      icon={<SlidersHorizontal />}
                      title="Dark theme"
                      meta="Used whenever this appearance is active."
                      control={
                        <ThemeDropdown
                          ariaLabel="Dark theme"
                          heading="Dark themes"
                          variants={darkThemeVariants}
                          value={editor.draft().darkThemeId}
                          onChange={(darkThemeId) => setDraft({ darkThemeId })}
                        />
                      }
                    />
                  </section>
                  <section aria-label="Accent color">
                    <SettingsRow
                      icon={<SlidersHorizontal />}
                      title="Accent color"
                      meta={accentHelperText(editor.draft().accent)}
                      control={
                        <AppearanceRadioGroup
                          ariaLabel="Accent color"
                          class="items-end gap-1.5"
                          optionClass="w-8"
                          options={accentChoices().map((choice) => ({
                            value: choice.value,
                            label: `${choice.label} accent`,
                            content: (selected: boolean) => (
                              <>
                                <span class={accentChipClass(selected)}>
                                  {choice.value === 'theme' ? (
                                    <AccentDefaultSample variant={sampleVariant()} />
                                  ) : choice.value === 'custom' ? (
                                    <Show
                                      when={accentSelection() === 'custom' && customAccent()}
                                      fallback={
                                        <span
                                          class="text-muted-foreground text-xs leading-none"
                                          aria-hidden="true"
                                        >
                                          +
                                        </span>
                                      }
                                    >
                                      <ColorSwatch color={customAccent()} label="Custom accent" />
                                    </Show>
                                  ) : (
                                    <ColorSwatch
                                      color={choice.color!}
                                      label={`${choice.label} accent preview`}
                                    />
                                  )}
                                </span>
                                <span
                                  class={cn(
                                    'h-0.5 w-6 rounded-full',
                                    selected ? 'bg-primary' : 'bg-transparent'
                                  )}
                                />
                              </>
                            ),
                          }))}
                          value={accentSelection()}
                          onChange={(value) => {
                            if (value === 'custom') {
                              applyCustomAccent(customAccent() || '#2563eb')
                              return
                            }
                            setDraft({ accent: value })
                          }}
                        />
                      }
                    />
                    <div class="px-5 pb-3.5">
                      <Show
                        when={accentSelection() === 'custom'}
                        fallback={
                          <p class="text-muted-foreground/65 text-xs" role="status">
                            {accentStatus() || ACCENT_NORMALIZATION_NOTE}
                          </p>
                        }
                      >
                        <div class="flex items-center gap-2">
                          <label class="flex items-center gap-2 text-xs text-muted-foreground">
                            Custom hex
                            <Input
                              type="text"
                              class="h-7 w-32"
                              aria-label="Custom accent color as a hex value"
                              placeholder="#2563eb"
                              value={customAccent()}
                              onChange={(event) =>
                                applyCustomAccent(event.currentTarget.value.trim())
                              }
                            />
                          </label>
                          <p class="text-muted-foreground/65 min-w-0 flex-1 text-xs" role="status">
                            {accentStatus() || ACCENT_NORMALIZATION_NOTE}
                          </p>
                        </div>
                      </Show>
                    </div>
                  </section>
                  <section aria-label="Glass">
                    <SettingsRow
                      icon={<PanelsTopLeft />}
                      title="Glass"
                      meta={surfaceHelperText(editor.draft().surface)}
                      control={
                        <AppearanceRadioGroup
                          ariaLabel="Glass"
                          class="gap-1.5"
                          options={surfaceChoices.map((choice) => ({
                            value: choice.value,
                            label: choice.label,
                            content: (selected: boolean) => (
                              <span
                                class={cn(
                                  'flex h-7.5 items-center rounded-md border px-2.5 text-xs',
                                  selected
                                    ? 'border-primary bg-primary/10 font-medium text-primary'
                                    : 'border-border text-muted-foreground hover:bg-accent'
                                )}
                              >
                                {choice.label}
                              </span>
                            ),
                          }))}
                          value={editor.draft().surface}
                          onChange={(surface) => setDraft({ surface })}
                        />
                      }
                    />
                  </section>
                  <section aria-label="Reduce transparency">
                    <SettingsRow
                      icon={<EyeOff />}
                      title="Reduce transparency"
                      meta={
                        <span role="status">
                          <Show
                            when={reduceTransparencyForced()}
                            fallback="Keep solid surfaces for readability."
                          >
                            Reduced transparency is active: opaque surfaces are forced for
                            readability.
                          </Show>
                        </span>
                      }
                      control={
                        <Switch
                          checked={editor.draft().reduceTransparency}
                          onChange={(reduceTransparency) => setDraft({ reduceTransparency })}
                          aria-label="Reduce transparency"
                        />
                      }
                    />
                  </section>
                  <section aria-label="Theme library">
                    <SettingsRow
                      icon={<FolderOpen />}
                      title="Theme library"
                      meta="Import or link custom themes."
                      control={
                        <Button type="button" size="sm" onClick={() => setLibraryOpen(true)}>
                          Add theme
                        </Button>
                      }
                    />
                  </section>
                </div>
              </div>
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
      }
    >
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) setLibraryOpen(false)
        }}
      >
        <DialogContent class="max-w-md" aria-describedby="theme-library-description">
          <DialogHeader>
            <DialogTitle>Add a theme</DialogTitle>
            <DialogDescription id="theme-library-description">
              Import a local theme into your library or keep it linked to its source.
            </DialogDescription>
          </DialogHeader>
          <div class="grid gap-3 px-6 pb-6 text-sm">
            <p class="text-muted-foreground">
              Custom themes must declare an explicit license and provenance; Adea never infers
              redistribution permission from a “User supplied” marker.
            </p>
            <p class="text-muted-foreground">
              Imports activate through the signed App Library pipeline; M12 ships the built-in set.
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setLibraryOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Show>
  )
}
