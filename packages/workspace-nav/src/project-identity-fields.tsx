import { AccentPicker } from '@adea-ai/ui/components/composites/accent-picker'
import { IconPicker } from '@adea-ai/ui/components/composites/icon-picker'
import { Input } from '@adea-ai/ui/components/ui/input'
import { Label } from '@adea-ai/ui/components/ui/label'
import { Text } from '@adea-ai/ui/components/ui/typography'
import { createUniqueId } from 'solid-js'

/** The key a project without a chosen icon wears: the folder every project starts with. */
export const DEFAULT_PROJECT_ICON_KEY = 'folder'

/**
 * ProjectIdentityFields.
 *
 * The fields every project settings surface shares: the name, the icon from
 * the shell's curated set, and an optional icon colour. A `null` colour keeps
 * the project on the accent of its workspace (and so the app), which is a real
 * choice rather than a missing one. Presentational only: the host owns the
 * values and saves them with the rest of its form.
 */
export function ProjectIdentityFields(props: {
  name: string
  onNameChange: (name: string) => void
  iconKey: string
  onIconKeyChange: (iconKey: string) => void
  accent: string | null
  onAccentChange: (accent: string | null) => void
  /** The name is read-only for a member who cannot rename the project. */
  nameDisabled?: boolean
  disabled?: boolean
  autofocus?: boolean
}) {
  const nameId = `project-name-${createUniqueId()}`
  return (
    <div class="flex flex-col gap-4" data-slot="project-identity-fields">
      <div class="flex flex-col gap-2">
        <Label for={nameId}>Name</Label>
        <Input
          id={nameId}
          value={props.name}
          maxLength={120}
          autofocus={props.autofocus}
          disabled={props.disabled || props.nameDisabled}
          onInput={(event) => props.onNameChange(event.currentTarget.value)}
        />
      </div>
      <div class="flex flex-col gap-2">
        <Text as="span" variant="label">
          Icon
        </Text>
        <IconPicker
          label="Project icon"
          value={props.iconKey}
          defaultKey={DEFAULT_PROJECT_ICON_KEY}
          disabled={props.disabled}
          onValueChange={props.onIconKeyChange}
        />
      </div>
      <div class="flex flex-col gap-2">
        <Text as="span" variant="label">
          Icon colour
        </Text>
        <AccentPicker
          label="Project icon colour"
          value={props.accent}
          inheritLabel="Inherit the workspace accent"
          disabled={props.disabled}
          onValueChange={props.onAccentChange}
        />
      </div>
    </div>
  )
}
