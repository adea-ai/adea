import { AccentPicker } from '@adea-ai/ui/components/composites/accent-picker'
import { IconPicker } from '@adea-ai/ui/components/composites/icon-picker'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Input } from '@adea-ai/ui/components/ui/input'
import { Label } from '@adea-ai/ui/components/ui/label'
import { Text } from '@adea-ai/ui/components/ui/typography'
import { createUniqueId, For, Show } from 'solid-js'
import type { NavMenuItem, NavMenuItemId } from './adapters'

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

/**
 * ProjectActionsSection.
 *
 * The project-level actions that used to sit in a ⋯ menu on the sidebar row
 * (Share, Archive, Delete), now at the foot of the settings dialog. Each button
 * hands its id to the host, which closes the dialog and opens the confirmation
 * or sharing flow it already owns; nothing here confirms or performs the
 * action. Renders nothing when the host offers none.
 */
export function ProjectActionsSection(props: {
  items: readonly NavMenuItem[]
  onSelect: (id: NavMenuItemId) => void
}) {
  return (
    <Show when={props.items.length > 0}>
      <section
        class="flex flex-col gap-3 border-t border-border pt-4"
        aria-label="Project actions"
        data-slot="project-actions"
      >
        <Text as="span" variant="label">
          Project actions
        </Text>
        <div class="flex flex-wrap gap-2">
          <For each={props.items}>
            {(item) => (
              <Button
                type="button"
                variant={item.destructive ? 'destructive' : 'outline'}
                onClick={() => props.onSelect(item.id)}
              >
                {item.label}
              </Button>
            )}
          </For>
        </div>
      </section>
    </Show>
  )
}
