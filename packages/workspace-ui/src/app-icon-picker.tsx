import {
  appIconLabels,
  appIconSrc,
  appIconVariants,
  isAppIconVariant,
  type AppIconVariant,
} from '@adea-ai/app-ui/lib/app-icon'
import { RadioGroup, RadioGroupItem } from '@adea-ai/ui/components/ui/radio-group'
import { SettingsRow } from '@adea-ai/ui/components/composites/settings'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import { createSignal, For, Show } from 'solid-js'

/**
 * The Dock and desktop icon colourway (desktop only). It never changes the icon
 * drawn inside the app, which follows light and dark appearance.
 */
export function AppIconPicker(props: {
  value: AppIconVariant
  disabled?: boolean
  onChange(variant: AppIconVariant): void
}) {
  return (
    <RadioGroup
      aria-label="App icon"
      value={props.value}
      disabled={props.disabled}
      onChange={(value) => {
        if (isAppIconVariant(value)) props.onChange(value)
      }}
    >
      <For each={appIconVariants}>
        {(variant) => (
          <RadioGroupItem
            value={variant}
            variant="card"
            label={appIconLabels[variant]}
            media={
              <img
                src={appIconSrc(variant)}
                alt=""
                aria-hidden="true"
                class="size-10 shrink-0"
                draggable={false}
              />
            }
          />
        )}
      </For>
    </RadioGroup>
  )
}

/**
 * The Settings row for the Dock icon. The pick only counts once `save` reports
 * it persisted: a failed save keeps its error, leaves the Dock alone, and never
 * reads as saved. `apply` then asks the shell to change the icon now; false
 * means the shell kept the pick but cannot change the icon while it runs.
 */
export function AppIconSetting(props: {
  value: AppIconVariant
  /** Resolves true only when the pick was persisted. */
  save(variant: AppIconVariant): Promise<boolean>
  apply(variant: AppIconVariant): Promise<boolean>
}) {
  const [outcome, setOutcome] = createSignal<'applied' | 'error' | 'idle' | 'saved'>('idle')
  let request = 0
  const choose = async (variant: AppIconVariant) => {
    const current = ++request
    setOutcome('idle')
    const persisted = await props.save(variant).catch(() => false)
    if (current !== request) return
    if (!persisted) {
      setOutcome('error')
      return
    }
    const applied = await props.apply(variant).catch(() => false)
    if (current === request) setOutcome(applied ? 'applied' : 'saved')
  }
  return (
    <SettingsRow
      label="App icon"
      description={
        outcome() === 'saved'
          ? 'Saved. This version of Adea Desktop cannot change the Dock icon while it runs.'
          : 'The Dock and desktop icon. Inside the app, the icon is white in light mode and black in dark mode.'
      }
    >
      <div class="flex flex-col gap-2">
        <AppIconPicker value={props.value} onChange={(variant) => void choose(variant)} />
        <Show when={outcome() === 'error'}>
          <Alert variant="destructive" role="alert">
            <AlertDescription>The app icon could not be saved. Try again.</AlertDescription>
          </Alert>
        </Show>
      </div>
    </SettingsRow>
  )
}
