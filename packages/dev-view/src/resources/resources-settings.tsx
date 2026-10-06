/*
 * Resource settings, inside the sheet (there is no resource section in App
 * Settings). Each change is saved right away through
 * `dev.resources.preferencesUpdate`; the host clamps every number and
 * answers with the stored document, which is what the view shows next.
 * Only settings something reads today are offered here.
 */
import type { ResourcePreferencesInput } from '@adea-ai/types/dev-runtime'
import { ChevronLeft, X } from 'lucide-solid'
import { createSignal, For, Show } from 'solid-js'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Checkbox } from '@adea-ai/ui/components/ui/checkbox'
import { FormField, NumberField } from '@adea-ai/ui/components/ui/field'
import { Input } from '@adea-ai/ui/components/ui/input'
import { NativeSelect } from '@adea-ai/ui/components/ui/native-select'
import { Switch as Toggle } from '@adea-ai/ui/components/ui/switch'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'

import { FALLBACK_PREFERENCES, KNOWN_HARNESSES } from './resources-view-model'

const GiB = 1024 ** 3
const MiB = 1024 ** 2

export function ResourceSettings(props: {
  preferences: ResourcePreferencesInput
  /** False when the host cannot store settings; controls are then read-only. */
  editable: boolean
  saving: boolean
  error?: string
  onChange(next: ResourcePreferencesInput): void
  onBack(): void
}) {
  const prefs = () => props.preferences
  const [newProtected, setNewProtected] = createSignal('')
  const update = (patch: Partial<ResourcePreferencesInput>) =>
    props.onChange({ ...prefs(), ...patch })
  const disabled = () => !props.editable

  function addProtected(): void {
    const name = newProtected().trim()
    if (!name || name.includes('/') || prefs().protectedExecutables.includes(name)) return
    update({ protectedExecutables: [...prefs().protectedExecutables, name].slice(0, 32) })
    setNewProtected('')
  }

  return (
    <section class="dev-resources__view" aria-label="Resource settings">
      <div class="dev-resources__view-header">
        <ActionButton
          type="button"
          variant="ghost"
          size="icon-sm"
          tooltip="Back"
          aria-label="Back to runtime resources"
          onClick={props.onBack}
        >
          <ChevronLeft aria-hidden="true" />
        </ActionButton>
        <div class="dev-resources__row-main">
          <span class="dev-resources__row-title">Resource settings</span>
          <span class="dev-resources__row-detail">
            {props.saving ? 'Saving…' : 'Changes apply right away.'}
          </span>
        </div>
      </div>

      <Show when={!props.editable}>
        <p class="dev-resources__note">
          This runtime cannot store resource settings; defaults apply.
        </p>
      </Show>
      <Show when={props.error}>
        {(message) => (
          <Alert variant="destructive">
            <AlertDescription>{message()}</AlertDescription>
          </Alert>
        )}
      </Show>

      <section class="dev-resources__settings-group" aria-label="What to show">
        <h3 class="dev-resources__group-title">What to show</h3>
        <Toggle
          checked={prefs().coverage === 'machine'}
          disabled={disabled()}
          onChange={(value: boolean) => update({ coverage: value ? 'machine' : 'adea' })}
          label="Whole machine"
          description="Include servers and apps Adea didn’t start. Off shows only Adea’s own."
        />
        <Toggle
          checked={prefs().includeAutomationApps}
          disabled={disabled() || prefs().coverage !== 'machine'}
          onChange={(value: boolean) => update({ includeAutomationApps: value })}
          label="Apps driven by automation"
          description="Browsers and simulators started with automation flags, such as Chrome for Testing."
        />
        <fieldset
          class="dev-resources__fieldset"
          disabled={disabled() || prefs().coverage !== 'machine'}
        >
          <legend class="dev-resources__row-title">Recognise these agent tools</legend>
          <span class="dev-resources__row-detail">
            Their servers are labelled with the tool that started them.
          </span>
          <div class="dev-resources__checks">
            <For each={KNOWN_HARNESSES}>
              {(harness) => (
                <Checkbox
                  checked={prefs().recognizedHarnesses.includes(harness)}
                  disabled={disabled() || prefs().coverage !== 'machine'}
                  onChange={(value: boolean) =>
                    update({
                      recognizedHarnesses: value
                        ? [...prefs().recognizedHarnesses, harness]
                        : prefs().recognizedHarnesses.filter((entry) => entry !== harness),
                    })
                  }
                  label={harness}
                />
              )}
            </For>
          </div>
        </fieldset>
        <div class="dev-resources__field-pair">
          <NumberField
            label="Lowest port"
            hint="Loopback listeners only"
            value={prefs().portRange.from}
            min={1}
            max={65_535}
            integer
            onChange={(value) => update({ portRange: { ...prefs().portRange, from: value } })}
          />
          <NumberField
            label="Highest port"
            value={prefs().portRange.to}
            min={1}
            max={65_535}
            integer
            onChange={(value) => update({ portRange: { ...prefs().portRange, to: value } })}
          />
        </div>
      </section>

      <section class="dev-resources__settings-group" aria-label="Memory alerts">
        <h3 class="dev-resources__group-title">Memory alerts</h3>
        <div class="dev-resources__field-pair">
          <NumberField
            label="Over (GB)"
            hint="Per server, including its child processes"
            value={Math.round((Number(prefs().alerts.residentBytesAbove) / GiB) * 100) / 100}
            min={0.25}
            max={64}
            onChange={(value) =>
              update({
                alerts: { ...prefs().alerts, residentBytesAbove: String(Math.round(value * GiB)) },
              })
            }
          />
          <NumberField
            label="Growing by (MB)"
            hint="Marks a server as leaking"
            value={Math.round(Number(prefs().alerts.growthBytes) / MiB)}
            min={16}
            max={65_536}
            integer
            onChange={(value) =>
              update({
                alerts: { ...prefs().alerts, growthBytes: String(Math.round(value * MiB)) },
              })
            }
          />
        </div>
        <NumberField
          label="Within (minutes)"
          value={Math.round(prefs().alerts.growthWindowSeconds / 60)}
          min={1}
          max={60}
          integer
          onChange={(value) =>
            update({ alerts: { ...prefs().alerts, growthWindowSeconds: Math.round(value * 60) } })
          }
        />
      </section>

      <section class="dev-resources__settings-group" aria-label="Clean up">
        <h3 class="dev-resources__group-title">Clean up</h3>
        <FormField
          label="When something qualifies"
          hint="Automatic clean-up needs an approved clean-up policy runner, which this version does not have."
          controlId="dev-resources-cleanup-mode"
        >
          <NativeSelect
            id="dev-resources-cleanup-mode"
            value={prefs().cleanup.mode}
            disabled={disabled()}
            options={[
              { value: 'ask', label: 'Ask first' },
              { value: 'off', label: 'Off' },
              { value: 'automatic', label: 'Automatic (not available yet)', disabled: true },
            ]}
            onChange={(event) =>
              update({
                cleanup: {
                  ...prefs().cleanup,
                  mode: event.currentTarget.value as ResourcePreferencesInput['cleanup']['mode'],
                },
              })
            }
          />
        </FormField>
        <NumberField
          label="A server is idle after (hours)"
          hint="Every CPU sample in that time stayed under 1%"
          value={Math.round((prefs().cleanup.serverIdleSeconds / 3600) * 4) / 4}
          min={0.25}
          max={168}
          onChange={(value) =>
            update({
              cleanup: { ...prefs().cleanup, serverIdleSeconds: Math.round(value * 3600) },
            })
          }
        />
      </section>

      <section class="dev-resources__settings-group" aria-label="Protected processes">
        <h3 class="dev-resources__group-title">Protected processes</h3>
        <span class="dev-resources__row-detail">
          Never offered a stop button. System processes, Adea itself, and other users’ processes are
          always protected.
        </span>
        <ul class="dev-resources__chips">
          <For each={prefs().protectedExecutables}>
            {(name) => (
              <li class="dev-resources__chip">
                <span class="dev-resources__code">{name}</span>
                <ActionButton
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  tooltip={`Stop protecting ${name}`}
                  aria-label={`Stop protecting ${name}`}
                  disabled={disabled()}
                  onClick={() =>
                    update({
                      protectedExecutables: prefs().protectedExecutables.filter(
                        (entry) => entry !== name
                      ),
                    })
                  }
                >
                  <X aria-hidden="true" />
                </ActionButton>
              </li>
            )}
          </For>
        </ul>
        <div class="dev-resources__add-row">
          <FormField
            label="Add a process name"
            hint="End with * to match a prefix, such as com.docker.*"
            controlId="dev-resources-protect"
          >
            <Input
              id="dev-resources-protect"
              value={newProtected()}
              disabled={disabled()}
              onInput={(event) => setNewProtected(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') addProtected()
              }}
            />
          </FormField>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled()}
            onClick={addProtected}
          >
            Add
          </Button>
        </div>
      </section>

      <section class="dev-resources__settings-group" aria-label="Sampling">
        <h3 class="dev-resources__group-title">Sampling</h3>
        <FormField label="While this sheet is open" controlId="dev-resources-sampling">
          <NativeSelect
            id="dev-resources-sampling"
            value={String(prefs().sampling.visibleSeconds)}
            disabled={disabled()}
            options={[
              { value: '2', label: 'Every 2 seconds' },
              { value: '5', label: 'Every 5 seconds' },
              { value: '10', label: 'Every 10 seconds' },
              { value: '30', label: 'Every 30 seconds' },
            ]}
            onChange={(event) =>
              update({
                sampling: {
                  ...prefs().sampling,
                  visibleSeconds: Number(event.currentTarget.value),
                },
              })
            }
          />
        </FormField>
      </section>

      <div class="dev-resources__footer">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled()}
          onClick={() => props.onChange(FALLBACK_PREFERENCES)}
        >
          Reset to defaults
        </Button>
      </div>
    </section>
  )
}
