import {
  appIconLabels,
  appIconSrc,
  appIconVariants,
  isAppIconVariant,
  type AppIconVariant,
} from '@adea-ai/app-ui/lib/app-icon'
import { RadioGroup, RadioGroupItem } from '@adea-ai/ui/components/ui/radio-group'
import { For } from 'solid-js'

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
