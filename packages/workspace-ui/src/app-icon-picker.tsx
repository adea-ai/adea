import {
  appIconLabels,
  appIconSrc,
  appIconVariants,
  type AppIconVariant,
} from '@adea-ai/app-ui/lib/app-icon'
import { RadioGroup, RadioGroupItem } from '@adea-ai/ui/components/ui/radio-group'
import { SettingsRow } from '@adea-ai/ui/components/composites/settings'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import { createSignal, For, Show } from 'solid-js'

/**
 * The Settings row for the Dock and desktop icon colourway (desktop only). It
 * never changes the icon drawn inside the app, which follows light and dark
 * appearance. The pick only counts once `save` reports it persisted: a failed
 * save keeps its error, leaves the Dock alone, and never reads as saved.
 * `apply` then asks the shell to change the icon now; false means the shell
 * kept the pick but cannot change the icon while it runs.
 */
export function AppIconSetting(props: {
  value: AppIconVariant
  /** Resolves true only when the pick was persisted; never rejects. */
  save(variant: AppIconVariant): Promise<boolean>
  apply(variant: AppIconVariant): Promise<boolean>
}) {
  const [outcome, setOutcome] = createSignal<'error' | 'idle' | 'saved'>('idle')
  let request = 0
  const choose = async (variant: AppIconVariant) => {
    const current = ++request
    setOutcome('idle')
    const persisted = await props.save(variant)
    if (current !== request) return
    if (!persisted) {
      setOutcome('error')
      return
    }
    const applied = await props.apply(variant).catch(() => false)
    if (current === request) setOutcome(applied ? 'idle' : 'saved')
  }
  return (
    <SettingsRow
      label="App icon"
      description={
        outcome() === 'saved'
          ? 'Saved. This version cannot change the Dock icon while Adea runs.'
          : 'The Dock and desktop icon. Inside the app it follows light and dark.'
      }
    >
      <div class="flex flex-col gap-2">
        <RadioGroup
          aria-label="App icon"
          value={props.value}
          onChange={(value) => void choose(value as AppIconVariant)}
        >
          <For each={appIconVariants}>
            {(variant) => (
              <RadioGroupItem
                value={variant}
                variant="card"
                label={appIconLabels[variant]}
                media={<img src={appIconSrc(variant)} alt="" class="size-10 shrink-0" />}
              />
            )}
          </For>
        </RadioGroup>
        <Show when={outcome() === 'error'}>
          <Alert variant="destructive" role="alert">
            <AlertDescription>Could not save the app icon.</AlertDescription>
          </Alert>
        </Show>
      </div>
    </SettingsRow>
  )
}
