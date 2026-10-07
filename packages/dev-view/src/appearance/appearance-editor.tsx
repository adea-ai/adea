/*
 * MIT License
 *
 * Copyright (c) 2026 Wing
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
/*
 * Adea's app-local recomposition of the published @adea-ai/ui
 * AppearanceEditor (pinned at 0.113.0), adapted from
 * `composites/appearance-editor` at that version. The published editor owns
 * the same presentation, but its row order and accent-picker internals are
 * fixed composition the host cannot re-arrange through props:
 *
 * - the text (font) settings render in the middle of the row stack, while
 *   Adea wants them last in the appearance options;
 * - the accent grid hardcodes a leading "Theme default" swatch and a
 *   duplicated "Custom" caption over its custom control.
 *
 * This module keeps every control on published primitives (RadioGroup,
 * DropdownMenu, Sheet, Switch, Input, Label, Button) and reuses the published
 * previews (ThemeMiniature, PalettePreview) plus the published
 * AppearanceFontSettingsGroup and AppearanceEditorActions verbatim, so the
 * shared design system still owns styling, keyboard behaviour, and menu focus
 * management. Adea owns only the row order and the accent entries here;
 * upstreaming an ordering/customization seam back to @adea-ai/ui retires this
 * fork (see the appearance PR for the library follow-up).
 */
import type { AdeaTheme, AdeaThemeRecord, AccentPreset } from '@adea-ai/themes'
import {
  AppearanceEditorActions,
  AppearanceFontSettingsGroup,
  DEFAULT_APPEARANCE_EDITOR_FONT_SETTINGS,
  PalettePreview,
  ThemeMiniature,
  ThemeMiniatureSplit,
  type AppearanceEditorProps,
  type AppearancePopoverProps,
} from '@adea-ai/ui/components/composites/appearance-editor'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { Button } from '@adea-ai/ui/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@adea-ai/ui/components/ui/dropdown-menu'
import { Input } from '@adea-ai/ui/components/ui/input'
import { Label } from '@adea-ai/ui/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@adea-ai/ui/components/ui/radio-group'
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@adea-ai/ui/components/ui/sheet'
import { Switch } from '@adea-ai/ui/components/ui/switch'
import {
  EyeOff,
  ChevronDown,
  Palette,
  PanelsTopLeft,
  SlidersHorizontal,
  SquareTerminal,
} from 'lucide-solid'
import { For, Show, createMemo, createSignal, createUniqueId, onCleanup, type JSX } from 'solid-js'

import { isThemeAccentId } from '@adea-ai/app-ui/components/appearance'
import { cn } from '@adea-ai/app-ui/lib/utils'

/**
 * Whether the draft accent is the host's custom colour: not the theme default,
 * not a preset, and not a theme accent id. A theme accent id counts as known even
 * when the current pair cannot offer it — it is a stored role, not a colour the
 * user typed, and showing it in the custom field would invite editing `ansi-blue`.
 */
export function isCustomAccent(props: AppearanceEditorProps): boolean {
  const accent = props.draft.accent
  return (
    accent !== 'theme' &&
    !props.accentOptions.some((option) => option.id === accent) &&
    !isThemeAccentId(accent)
  )
}

/*
 * Retains the compact divided row and palette-preview selector from the pinned
 * Zeron/Adea composition; Kobalte owns option navigation and dismissal. One
 * shared menu serves the light, dark, and terminal rows: each option carries a
 * published palette preview beside its name, and the menu sizes to that
 * content instead of clipping it at the trigger width.
 */
const POINTER_FOCUS_TARGET_SELECTOR =
  'a[href], area[href], button, input, select, textarea, iframe, [tabindex], [contenteditable], details > summary:first-of-type'

function isTabStop(element: HTMLElement) {
  return (
    (element.tabIndex >= 0 ||
      (element.matches('details > summary:first-of-type') && !element.hasAttribute('tabindex'))) &&
    !element.matches(':disabled') &&
    element.getAttribute('aria-disabled') !== 'true' &&
    element.closest('[hidden], [inert], [aria-hidden="true"]') === null &&
    element.getClientRects().length > 0
  )
}

export function SettingsRow(props: {
  title: string
  icon: JSX.Element
  description?: JSX.Element
  children: JSX.Element
}) {
  return (
    <section class="flex flex-wrap items-center gap-3 px-4 py-4">
      {/* Reserve readable copy before choosing a side-by-side control row.
          Wrapping follows the actual host width and enlarged text, rather
          than a viewport breakpoint that also matches a narrow popover. */}
      <div class="flex min-w-0 flex-1 basis-48 items-center gap-3">
        <span
          class="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-foreground/5 text-muted-foreground [&_svg]:size-4"
          aria-hidden="true"
        >
          {props.icon}
        </span>
        <div class="min-w-0">
          <h3 class="text-sm font-medium">{props.title}</h3>
          <Show when={props.description}>
            <div class="mt-0.5 text-xs text-muted-foreground">{props.description}</div>
          </Show>
        </div>
      </div>
      <div class="min-w-0 max-w-full shrink-0">{props.children}</div>
    </section>
  )
}

/** One selectable palette in a theme menu. */
export type ThemeOption = {
  id: string
  name: string
  description?: string
  preview: AdeaTheme
}

/**
 * The shared theme picker. Kobalte handles menu navigation and dismissal;
 * this port moves Tab to the adjacent browser-reported stop because menus
 * consume Tab by default. Enumerating elements and checking their native
 * tabIndex keeps details summaries in the order while preserving explicit
 * tabindex overrides. The menu width follows its content (bounded by the
 * popper's available width) so a long theme name and its description render
 * fully instead of truncating at the trigger's width.
 */
function ThemeSelectMenu(props: {
  /** Row title; also the trigger's accessible name and the group's label. */
  label: string
  selectedId: string
  /** Palette shown on the trigger; hosts pass the accent-applied preview. */
  triggerPreview: AdeaTheme
  options: readonly ThemeOption[]
  disabled?: boolean
  onSelect: (id: string) => void
}) {
  const [portalMount, setPortalMount] = createSignal<HTMLDivElement>()
  const [triggerElement, setTriggerElement] = createSignal<HTMLButtonElement>()
  const [menuOpen, setMenuOpen] = createSignal(false)
  const [focusOutsideTarget, setFocusOutsideTarget] = createSignal<HTMLElement>()
  const [restoreTriggerFocus, setRestoreTriggerFocus] = createSignal(false)
  let focusTargetAfterTab: HTMLElement | undefined
  let focusLifecycleVersion = 0
  onCleanup(() => {
    focusLifecycleVersion += 1
  })
  const selected = createMemo(
    () =>
      props.options.find((option) => option.id === props.selectedId) ??
      props.options.find((option) => option.id === props.triggerPreview.id)
  )
  const closeMenu = () => {
    if (menuOpen()) focusLifecycleVersion += 1
    setMenuOpen(false)
  }
  const moveFocusOnTab = (event: KeyboardEvent) => {
    if (event.key !== 'Tab' || event.isComposing) return

    const trigger = triggerElement()
    if (!trigger) return
    const parentDialog = portalMount()?.closest<HTMLElement>('[role="dialog"]')
    const focusScope = parentDialog ?? portalMount()?.ownerDocument.body
    if (!focusScope) return

    const focusStops = Array.from(focusScope.querySelectorAll<HTMLElement>('*')).filter(
      (element) =>
        isTabStop(element) &&
        element.closest('[role="menu"], [hidden], [inert], [aria-hidden="true"]') === null
    )
    const orderedFocusStops = [
      ...focusStops
        .filter((element) => element.tabIndex > 0)
        .toSorted((a, b) => a.tabIndex - b.tabIndex),
      ...focusStops.filter((element) => element.tabIndex <= 0),
    ]
    const triggerIndex = orderedFocusStops.indexOf(trigger)
    const direction = event.shiftKey ? -1 : 1
    const adjacent =
      orderedFocusStops[triggerIndex + direction] ??
      (parentDialog ? (direction > 0 ? orderedFocusStops[0] : orderedFocusStops.at(-1)) : undefined)

    event.stopPropagation()
    setRestoreTriggerFocus(false)
    if (adjacent) {
      event.preventDefault()
      focusTargetAfterTab = adjacent
      setFocusOutsideTarget(adjacent)
      closeMenu()
      adjacent.focus({ preventScroll: true })
    } else {
      focusTargetAfterTab = undefined
      setFocusOutsideTarget(undefined)
      closeMenu()
    }
  }
  return (
    <div ref={setPortalMount}>
      <DropdownMenu
        modal={false}
        open={menuOpen()}
        onOpenChange={(open) => {
          if (open !== menuOpen()) focusLifecycleVersion += 1
          setMenuOpen(open)
          if (open) {
            focusTargetAfterTab = undefined
            setFocusOutsideTarget(undefined)
            setRestoreTriggerFocus(false)
          }
        }}
      >
        <DropdownMenuTrigger
          ref={setTriggerElement}
          as={Button}
          variant="outline"
          size="sm"
          aria-label={props.label}
          disabled={props.disabled || props.options.length === 0}
          class="w-full justify-between sm:w-52"
        >
          <span class="flex min-w-0 flex-1 items-center gap-2">
            <PalettePreview theme={props.triggerPreview} />
            <span class="min-w-0 flex-1 truncate">
              {selected()?.name ?? props.triggerPreview.name}
            </span>
          </span>
          <ChevronDown aria-hidden="true" class="shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          portalMount={portalMount()}
          class="max-h-80 w-max min-w-(--kb-popper-anchor-width) max-w-(--kb-popper-content-available-width) overflow-x-hidden overflow-y-auto"
          onInteractOutside={(event) => {
            if (event.detail.originalEvent.type !== 'pointerdown') return
            const parentDialog = portalMount()?.closest<HTMLElement>('[role="dialog"]')
            const focusScope = parentDialog ?? portalMount()?.ownerDocument.body
            const target = event.detail.originalEvent.target
            if (!(target instanceof Element) || !focusScope?.contains(target)) return

            const focusTarget = target.closest<HTMLElement>(POINTER_FOCUS_TARGET_SELECTOR)
            if (focusTarget && isTabStop(focusTarget)) {
              setRestoreTriggerFocus(false)
              setFocusOutsideTarget(focusTarget)
            } else {
              setRestoreTriggerFocus(true)
            }
          }}
          onFocusOutside={(event) => {
            // The containing dialog or document body can briefly reclaim
            // focus when the menu opens. Keep that handoff from dismissing
            // it; focus moving to another descendant still closes the menu.
            const parentDialog = portalMount()?.closest<HTMLElement>('[role="dialog"]')
            const focusScope = parentDialog ?? portalMount()?.ownerDocument.body
            const target = event.detail.originalEvent.target
            if (target === focusScope) {
              event.preventDefault()
            } else if (target instanceof HTMLElement && focusScope?.contains(target)) {
              setRestoreTriggerFocus(false)
              setFocusOutsideTarget(target)
            }
          }}
          onEscapeKeyDown={() => setRestoreTriggerFocus(true)}
          onCloseAutoFocus={(event) => {
            // A prior menu instance can finish its focus cleanup after this
            // row has already reopened. Do not let that cleanup steal focus.
            if (menuOpen()) {
              event.preventDefault()
              return
            }

            const lifecycleVersion = focusLifecycleVersion
            const shouldRestore = restoreTriggerFocus()
            const focusTarget = focusTargetAfterTab ?? focusOutsideTarget()
            focusTargetAfterTab = undefined
            setFocusOutsideTarget(undefined)
            setRestoreTriggerFocus(false)
            if (shouldRestore) {
              // The saved focus may be the containing dialog rather than
              // the trigger when WebKit opens this menu from a pointer click.
              event.preventDefault()
              triggerElement()?.focus({ preventScroll: true })
              return
            }

            const parentDialog = portalMount()?.closest<HTMLElement>('[role="dialog"]')
            const focusScope = parentDialog ?? portalMount()?.ownerDocument.body
            if (focusTarget?.isConnected && focusScope?.contains(focusTarget)) {
              // Preserve the intended in-scope destination across
              // Kobalte's deferred stale-focus restore.
              event.preventDefault()
              queueMicrotask(() => {
                if (lifecycleVersion !== focusLifecycleVersion || menuOpen()) return

                const activeElement = document.activeElement
                const isMenuFocus =
                  activeElement instanceof HTMLElement &&
                  activeElement.closest('[role="menu"]') !== null
                const isTriggerFocus = activeElement === triggerElement()
                if (
                  activeElement !== focusTarget &&
                  (activeElement === document.body ||
                    activeElement === focusScope ||
                    isMenuFocus ||
                    isTriggerFocus)
                ) {
                  focusTarget.focus({ preventScroll: true })
                }
              })
              return
            }

            const activeElement = document.activeElement
            if (
              focusScope &&
              activeElement instanceof HTMLElement &&
              activeElement !== focusScope &&
              focusScope.contains(activeElement) &&
              activeElement.closest('[role="menu"]') === null
            ) {
              // Preserve a real focus target in this scope instead of
              // restoring the stale element captured when the menu mounted. A
              // focused menu item is about to unmount, so Kobalte must restore
              // focus to the trigger instead.
              event.preventDefault()
            }
          }}
        >
          <DropdownMenuRadioGroup
            value={selected()?.id ?? ''}
            aria-label={`${props.label} options`}
            on:keydown={moveFocusOnTab}
            onChange={(id) => {
              if (!props.disabled && typeof id === 'string') props.onSelect(id)
            }}
          >
            <For each={props.options}>
              {(option) => (
                <DropdownMenuRadioItem
                  value={option.id}
                  textValue={option.name}
                  closeOnSelect={true}
                  disabled={props.disabled}
                  onSelect={() => setRestoreTriggerFocus(true)}
                >
                  {/* The published menu preview element keeps the data hook
                      the browser specs select on; the palette strip itself is
                      the published primitive. */}
                  <span data-theme-menu-preview aria-hidden="true">
                    <PalettePreview theme={option.preview} />
                  </span>
                  <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span class="truncate">{option.name}</span>
                    {/* Visual affordance only: the accessible name stays the
                        theme name, which is what keyboard and test callers
                        match on. */}
                    <Show when={option.description}>
                      <span
                        aria-hidden="true"
                        class="line-clamp-2 max-w-44 text-2xs text-muted-foreground"
                      >
                        {option.description}
                      </span>
                    </Show>
                  </span>
                </DropdownMenuRadioItem>
              )}
            </For>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/**
 * A compact persistent theme choice for one appearance.
 */
export function ThemeRow(props: {
  appearance: 'light' | 'dark'
  selectedId: string
  preview: AdeaTheme
  themes: readonly AdeaThemeRecord[]
  disabled?: boolean
  onSelect: (id: string) => void
}) {
  const label = () => (props.appearance === 'light' ? 'Light theme' : 'Dark theme')
  const options = createMemo<ThemeOption[]>(() =>
    props.themes
      .filter((theme) => theme.appearance === props.appearance)
      .map((theme) => ({
        id: theme.id,
        name: theme.name,
        description: theme.description,
        preview: theme,
      }))
  )
  return (
    <SettingsRow title={label()} icon={<Palette />}>
      <ThemeSelectMenu
        label={label()}
        selectedId={props.selectedId}
        triggerPreview={props.preview}
        options={options()}
        disabled={props.disabled}
        onSelect={props.onSelect}
      />
    </SettingsRow>
  )
}

/**
 * A terminal palette choice independent of the light/dark rows. The first
 * option (`'theme'`) follows the interface theme, painted with the resolved
 * preview; every catalogue record follows, both appearances, because the
 * terminal paints one fixed ANSI palette rather than an appearance axis.
 */
export function TerminalRow(props: {
  selectedId: string
  /** Resolved interface theme: the `theme` option's palette and the fallback. */
  preview: AdeaTheme
  themes: readonly AdeaThemeRecord[]
  disabled?: boolean
  onSelect: (id: string) => void
}) {
  const options = createMemo<ThemeOption[]>(() => [
    {
      id: 'theme',
      name: 'UI theme',
      description: 'Uses the interface theme.',
      preview: props.preview,
    },
    ...props.themes.map((theme) => ({
      id: theme.id,
      name: theme.name,
      description: theme.description,
      preview: theme,
    })),
  ])
  const selectedOption = () => options().find((option) => option.id === props.selectedId)
  const description = () =>
    selectedOption() && selectedOption()?.id !== 'theme'
      ? `The terminal follows ${selectedOption()?.name}.`
      : 'The terminal follows the interface theme.'
  return (
    <SettingsRow title="Terminal" icon={<SquareTerminal />} description={description()}>
      <ThemeSelectMenu
        label="Terminal"
        selectedId={props.selectedId}
        triggerPreview={selectedOption()?.preview ?? props.preview}
        options={options()}
        disabled={props.disabled}
        onSelect={props.onSelect}
      />
    </SettingsRow>
  )
}

const MODES = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const
const SURFACES = [
  { value: 'theme', label: 'Theme default' },
  { value: 'frosted', label: 'Frosted' },
  { value: 'opaque', label: 'Opaque' },
] as const

export function ModeChoices(props: AppearanceEditorProps) {
  return (
    <RadioGroup
      value={props.draft.mode}
      disabled={props.saving}
      aria-label="Appearance mode"
      class="grid grid-cols-1 sm:grid-cols-3"
      onChange={(mode) => {
        const option = MODES.find((candidate) => candidate.value === mode)
        if (option) props.onChange({ mode: option.value })
      }}
    >
      <For each={MODES}>
        {(option) => (
          <div class="rounded-lg focus-within:ring-3 focus-within:ring-ring/50">
            {/* The card is the control's published Label (associated by the
                deterministic item/input id pair), so clicking anywhere on the
                miniature selects the mode; the hidden radio control keeps the
                group keyboard-driven and the wrapper carries its focus ring. */}
            <RadioGroupItem
              id={`appearance-mode-${option.value}`}
              value={option.value}
              controlClass="sr-only"
            >
              <Label for={`appearance-mode-${option.value}-input`} class="w-full">
                <span
                  class={cn(
                    'flex w-full cursor-pointer flex-col gap-2 rounded-lg border p-2 text-center text-xs',
                    {
                      'border-primary': props.draft.mode === option.value,
                    }
                  )}
                >
                  <span class="block h-20 w-full">
                    <Show
                      when={option.value === 'system'}
                      fallback={
                        <ThemeMiniature
                          theme={option.value === 'light' ? props.lightTheme : props.darkTheme}
                        />
                      }
                    >
                      <ThemeMiniatureSplit light={props.lightTheme} dark={props.darkTheme} />
                    </Show>
                  </span>
                  <span>{option.label}</span>
                </span>
              </Label>
            </RadioGroupItem>
          </div>
        )}
      </For>
    </RadioGroup>
  )
}

/**
 * The accent entries: every catalogue preset the host feeds, then the host's
 * custom colour. There is no separate "theme default" entry — the default
 * accent IS one of the presets (the catalogue's Violet), so the extra swatch
 * that duplicated the theme's own primary is gone, and one control named
 * "Custom" carries the free-form color (whose validation stays with the
 * host). The published composition also drew a second "Custom" caption above
 * its custom entry, which read as a label on the button itself.
 */
function accentEntries(accentOptions: readonly AccentPreset[]): readonly {
  id: string
  label: string
}[] {
  return accentOptions.filter((option) => option.id !== 'theme')
}

export function AccentChoices(props: AppearanceEditorProps) {
  const accentSelection = () => (isCustomAccent(props) ? 'custom' : props.draft.accent)
  return (
    <RadioGroup
      value={accentSelection()}
      disabled={props.saving}
      aria-label="Accent"
      class="grid sm:grid-cols-3"
      onChange={(accent) =>
        props.onChange({
          accent: accent === 'custom' ? (props.customAccentValue ?? '') : accent,
        })
      }
    >
      <For each={accentEntries(props.accentOptions)}>
        {(option) => <RadioGroupItem value={option.id} label={option.label} />}
      </For>
      <RadioGroupItem value="custom" label="Custom" />
    </RadioGroup>
  )
}

export function GlassChoices(props: AppearanceEditorProps) {
  return (
    <RadioGroup
      value={props.draft.surface}
      disabled={props.saving}
      aria-label="Glass"
      class="flex flex-wrap"
      onChange={(surface) => {
        const option = SURFACES.find((candidate) => candidate.value === surface)
        if (option) props.onChange({ surface: option.value })
      }}
    >
      <For each={SURFACES}>
        {(option) => (
          <RadioGroupItem
            value={option.value}
            label={option.label}
            disabled={option.value === 'frosted' && !props.surfaceCapability.frosted}
          />
        )}
      </For>
    </RadioGroup>
  )
}

/**
 * The live editor whose persistence and preview authority belong to its host.
 * No ThemeProvider is required, and no catalogue, renderer engine or storage is
 * imported. Hosts normalize unknown IDs and custom colors, report recovery,
 * snapshot on open, preview on changes, commit on Save, and restore on
 * dismissal. Both theme rows remain mounted when mode changes. Density remains
 * outside the accepted appearance surface; typeface settings are shared and
 * host-persisted.
 *
 * Row order is Adea's: the text (font) settings close the option list, after
 * every palette and surface choice.
 */
export function AdeaAppearanceEditor(props: AppearanceEditorProps) {
  const errorId = createUniqueId()
  const custom = () => isCustomAccent(props)
  const accentDescription = () => {
    if (props.draft.accent === 'theme') return "Theme default · Uses the palette's intended color."
    const preset = props.accentOptions.find((option) => option.id === props.draft.accent)
    if (preset) return `${preset.label} · Controls, glyphs, selections, code, and activity.`
    if (custom()) return 'Custom · Controls, glyphs, selections, code, and activity.'
    const offered = props.themeAccentOptions?.find((option) => option.id === props.draft.accent)
    // A stored theme accent survives a theme switch by id; when the new pair
    // cannot offer that slot the host falls back to the theme's own primary,
    // and the description says so rather than naming a colour not on screen.
    return offered
      ? `Theme ${offered.label.toLowerCase()} · The theme's own color, on controls and activity.`
      : "Theme default · This theme does not carry that accent, so it uses the palette's intended color."
  }
  const glassDescription = () =>
    props.draft.surface === 'opaque'
      ? 'Solid surfaces for every theme.'
      : props.draft.surface === 'frosted'
        ? 'Theme-colored glass where supported.'
        : (props.surfaceCapability.themeDefaultDescription ?? "Uses this theme's default surface.")
  return (
    <div data-appearance-editor class={cn('min-w-0', props.class)}>
      <Show when={props.recoveryNotice}>
        <p role="status" class="px-4 py-2 text-sm text-muted-foreground">
          {props.recoveryNotice}
        </p>
      </Show>
      <ModeChoices {...props} />
      <div class="divide-y divide-border rounded-lg border">
        <ThemeRow
          appearance="light"
          selectedId={props.draft.lightThemeId}
          preview={props.lightTheme}
          themes={props.themes}
          disabled={props.saving}
          onSelect={(lightThemeId) => props.onChange({ lightThemeId })}
        />
        <ThemeRow
          appearance="dark"
          selectedId={props.draft.darkThemeId}
          preview={props.darkTheme}
          themes={props.themes}
          disabled={props.saving}
          onSelect={(darkThemeId) => props.onChange({ darkThemeId })}
        />
        {/* The row exists only when the host carries a terminal preference:
            the draft field is the show/hide switch, so the editor can never
            render a terminal row that writes nothing. */}
        <Show when={props.draft.terminalThemeId !== undefined}>
          <TerminalRow
            selectedId={props.draft.terminalThemeId ?? 'theme'}
            preview={props.resolvedAppearance === 'dark' ? props.darkTheme : props.lightTheme}
            themes={props.themes}
            disabled={props.saving}
            onSelect={(terminalThemeId) => props.onChange({ terminalThemeId })}
          />
        </Show>
        <SettingsRow title="Accent" icon={<SlidersHorizontal />} description={accentDescription()}>
          <AccentChoices {...props} />
        </SettingsRow>
        <Show when={custom()}>
          <div class="px-4 py-3">
            <Label for={`${errorId}-input`}>Custom accent</Label>
            <Input
              id={`${errorId}-input`}
              value={props.draft.accent}
              disabled={props.saving}
              aria-invalid={!!props.customAccentError}
              aria-describedby={props.customAccentError ? errorId : undefined}
              onInput={(event) => props.onChange({ accent: event.currentTarget.value })}
            />
            <Show when={props.customAccentError}>
              <p id={errorId} role="alert" class="mt-1 text-xs text-foreground">
                {props.customAccentError}
              </p>
            </Show>
          </div>
        </Show>
        <SettingsRow title="Glass" icon={<PanelsTopLeft />} description={glassDescription()}>
          <GlassChoices {...props} />
        </SettingsRow>
        <Show when={!props.surfaceCapability.frosted && props.surfaceCapability.reason}>
          <p role="status" class="px-4 py-2 text-xs text-muted-foreground">
            {props.surfaceCapability.reason}
          </p>
        </Show>
        <SettingsRow
          title="Reduce transparency"
          icon={<EyeOff />}
          description="Prefer solid surfaces, including during live preview."
        >
          <Switch
            checked={props.draft.reduceTransparency}
            disabled={props.saving}
            onChange={(reduceTransparency: boolean) => props.onChange({ reduceTransparency })}
            aria-label="Reduce transparency"
          />
        </SettingsRow>
        <SettingsRow
          title="Theme library"
          icon={<Palette />}
          description={
            props.onManageThemes
              ? 'Manage themes through the application.'
              : 'Theme import is unavailable.'
          }
        >
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!props.onManageThemes || props.saving}
            onClick={() => props.onManageThemes?.()}
          >
            Manage themes
          </Button>
        </SettingsRow>
        {/* The text settings close the list: family and size rows come after
            every palette and surface choice (owner-requested order). */}
        <AppearanceFontSettingsGroup
          settings={props.draft.fonts ?? DEFAULT_APPEARANCE_EDITOR_FONT_SETTINGS}
          menuPortalMount={props.menuPortalMount}
          disabled={props.saving}
          onChange={(fonts) => props.onChange({ fonts })}
        />
      </div>
      <Show when={!props.hideActions}>
        {/* Sticky so Save/Cancel stay reachable in a tall scroll container: the
            editor scrolls with its host panel, and actions parked at the bottom
            of a long form were unreachable without scrolling past every row. */}
        <div class="sticky bottom-0 z-10 mt-2 border-t bg-background px-4 py-3">
          <AppearanceEditorActions {...props} />
        </div>
      </Show>
    </div>
  )
}

/** The editor in an inset Sheet docked beside the main view: the body scrolls and
 * Reset/Cancel/Save sit in the panel's full-width footer, always reachable.
 * Dismissal (Escape, the close button, an outside click) is `onDismiss`. The
 * trigger is this composition's own: when the host swaps its lazy fallback for
 * this popover, the trigger here is the persistent control focus returns to
 * after dismissal. */
export function AdeaAppearancePopover(props: AppearancePopoverProps) {
  const [menuPortalMount, setMenuPortalMount] = createSignal<HTMLElement>()

  return (
    <Sheet open={props.open} onOpenChange={(open) => (open ? props.onOpen() : props.onDismiss())}>
      <SheetTrigger
        as={ActionButton}
        variant="ghost"
        size="icon-sm"
        tooltip="Open appearance settings"
        aria-label="Appearance settings"
      >
        <Palette aria-hidden="true" />
      </SheetTrigger>
      <SheetContent side="end" closeLabel="Close appearance settings" ref={setMenuPortalMount}>
        <SheetHeader>
          <SheetTitle>Appearance</SheetTitle>
          <SheetDescription>
            Changes preview immediately. Save keeps them; Cancel restores the previous appearance.
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          <AdeaAppearanceEditor {...props} menuPortalMount={menuPortalMount()} hideActions />
        </SheetBody>
        <SheetFooter>
          <AppearanceEditorActions {...props} />
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
