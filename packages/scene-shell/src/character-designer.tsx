'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from 'react'
import {
  BadgeCheck,
  CircleDot,
  Crown,
  Ear,
  Footprints,
  Gem,
  Glasses,
  Hand,
  Layers3,
  Scissors,
  Shirt,
  Smile,
  Sparkles,
  UserRound,
  VenetianMask,
  X,
} from 'lucide-react'
import {
  createDefaultCharacterConfiguration,
  type CharacterConfiguration,
  type CharacterConfigurationSlot,
  type CharacterPartOption,
  type CharacterPartSlot,
} from '@agent-hq/characters'
import { ModelThumbnail, type PropCatalogItem } from '@agent-hq/ui/components/prop-catalog'
import { Button } from '@agent-hq/ui/components/ui/button'
import { cn } from '@agent-hq/ui/lib/utils'

export type CharacterDesignerValue = {
  character: string
  configuration?: CharacterConfiguration
}

export const characterDesignerSlotCategories: readonly {
  id: CharacterPartSlot
  label: string
  icon: typeof UserRound
}[] = [
  { id: 'body', label: 'Body', icon: UserRound },
  { id: 'ears', label: 'Ears', icon: Ear },
  { id: 'face', label: 'Face', icon: Smile },
  { id: 'hair', label: 'Hair', icon: Scissors },
  { id: 'hat', label: 'Hats', icon: Crown },
  { id: 'top', label: 'Tops', icon: Shirt },
  { id: 'bottom', label: 'Bottoms', icon: Layers3 },
  { id: 'shoes', label: 'Shoes', icon: Footprints },
  { id: 'socks', label: 'Socks', icon: CircleDot },
  { id: 'glasses', label: 'Glasses', icon: Glasses },
  { id: 'gloves', label: 'Gloves', icon: Hand },
  { id: 'accessory', label: 'Accessories', icon: Gem },
  { id: 'costume', label: 'Costumes', icon: VenetianMask },
]

const characterSlots: readonly CharacterConfigurationSlot[] = characterDesignerSlotCategories.map(
  ({ id }) => id
)

export function hasCharacterDesignerChanges(
  current: CharacterDesignerValue,
  saved: CharacterDesignerValue
): boolean {
  if (current.character !== saved.character) return true
  if (!current.configuration || !saved.configuration)
    return current.configuration !== saved.configuration
  return (
    current.configuration.version !== saved.configuration.version ||
    characterSlots.some((slot) => current.configuration?.[slot] !== saved.configuration?.[slot])
  )
}

export type CharacterDesignerProps = {
  enabled: boolean
  character: string
  characterOptions: readonly { id: string; label: string; iconUrl?: string }[]
  characterConfiguration?: CharacterConfiguration
  characterPartOptions: readonly CharacterPartOption[]
  onCharacterChange: (character: string) => void
  onCharacterConfigurationChange: (configuration: CharacterConfiguration) => void
  onCharacterConfigurationReset?: () => void
  onSave?: (value: CharacterDesignerValue) => void | boolean | Promise<void | boolean>
  onClose?: () => void
  saveRef?: MutableRefObject<(() => Promise<boolean>) | null>
  onDirtyChange?: (dirty: boolean) => void
}

type CharacterThumbnailItem = PropCatalogItem

const characterThumbnailFor = (
  option: CharacterDesignerProps['characterOptions'][number]
): CharacterThumbnailItem | null => {
  if (!/^[fm]_\d+$/.test(option.id)) return null
  return {
    id: option.id,
    label: option.label,
    assetUrl: `/assets/models/_complete/${option.id}.glb`,
    category: 'characters',
    frontYaw: Math.PI,
  }
}

function ChoiceCard({
  label,
  selected,
  onClick,
  children,
}: {
  label: string
  selected: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-label={label}
      aria-checked={selected}
      className={cn(
        'group relative flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-card/60 p-1 text-left transition-colors',
        'hover:border-primary/60 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected && 'border-primary bg-accent/70'
      )}
      onClick={onClick}
    >
      {children}
      <span className="truncate px-1 pb-1 text-[10px] font-medium text-foreground">{label}</span>
      {selected ? (
        <span className="pointer-events-none absolute right-2 top-2 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm">
          <BadgeCheck className="size-3.5" aria-hidden="true" />
        </span>
      ) : null}
    </button>
  )
}

export function CharacterDesigner({
  enabled,
  character,
  characterOptions,
  characterConfiguration,
  characterPartOptions,
  onCharacterChange,
  onCharacterConfigurationChange,
  onCharacterConfigurationReset,
  onSave,
  onClose,
  saveRef,
  onDirtyChange,
}: CharacterDesignerProps): ReactNode {
  const savedValueRef = useRef<CharacterDesignerValue>({
    character,
    configuration: characterConfiguration,
  })
  const [activeCategory, setActiveCategory] = useState<string>('body')
  const [status, setStatus] = useState('Choose a character or customize a slot.')
  const currentValue = useMemo(
    () => ({ character, configuration: characterConfiguration }),
    [character, characterConfiguration]
  )
  const hasEdits = hasCharacterDesignerChanges(currentValue, savedValueRef.current)
  const currentConfiguration = characterConfiguration
  const partOptionsBySlot = useMemo(() => {
    const result = new Map<CharacterPartSlot, readonly CharacterPartOption[]>()
    for (const category of characterDesignerSlotCategories) {
      result.set(
        category.id,
        characterPartOptions.filter((option) => option.slot === category.id)
      )
    }
    return result
  }, [characterPartOptions])
  const thumbnailItems = useMemo(
    () =>
      new Map(
        characterPartOptions.map((option) => [
          option.id,
          {
            id: option.id,
            label: option.label,
            assetUrl: `/assets/models/${option.file}`,
            category: option.slot,
            frontYaw: 0,
          } satisfies CharacterThumbnailItem,
        ])
      ),
    [characterPartOptions]
  )
  const characterThumbnails = useMemo(
    () => new Map(characterOptions.map((option) => [option.id, characterThumbnailFor(option)])),
    [characterOptions]
  )

  useEffect(() => {
    onDirtyChange?.(hasEdits)
  }, [hasEdits, onDirtyChange])

  const discard = useCallback(() => {
    const saved = savedValueRef.current
    onCharacterChange(saved.character)
    if (saved.configuration) onCharacterConfigurationChange(saved.configuration)
    else onCharacterConfigurationReset?.()
    setStatus('Unsaved character changes discarded.')
  }, [onCharacterChange, onCharacterConfigurationChange, onCharacterConfigurationReset])

  const save = useCallback(async (): Promise<boolean> => {
    const value = { character, configuration: characterConfiguration }
    setStatus('Saving character design…')
    try {
      const result = await onSave?.(value)
      if (result === false) {
        setStatus('Could not save character design.')
        return false
      }
      savedValueRef.current = {
        character: value.character,
        configuration: value.configuration,
      }
      setStatus('Character design saved.')
      return true
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not save character design.')
      return false
    }
  }, [character, characterConfiguration, onSave])

  useEffect(() => {
    if (!saveRef) return
    saveRef.current = save
    return () => {
      if (saveRef.current === save) saveRef.current = null
    }
  }, [save, saveRef])

  useEffect(() => {
    if (enabled || hasEdits) return
    savedValueRef.current = currentValue
  }, [currentValue, enabled, hasEdits])

  useEffect(() => {
    if (enabled || !hasEdits) return
    discard()
  }, [discard, enabled, hasEdits])

  const selectPart = (slot: CharacterPartSlot, value: string | null) => {
    const base = currentConfiguration ?? createDefaultCharacterConfiguration()
    if (character !== 'configurable') onCharacterChange('configurable')
    onCharacterConfigurationChange({ ...base, [slot]: value } as CharacterConfiguration)
    setStatus(`${slotLabel(slot)} updated.`)
  }

  const selectCharacter = (id: string) => {
    onCharacterChange(id)
    setStatus('Character preview updated.')
  }

  const activeSlot = characterDesignerSlotCategories.find(({ id }) => id === activeCategory)
  const activeParts = activeSlot ? (partOptionsBySlot.get(activeSlot.id) ?? []) : []
  const selectedPart = activeSlot ? currentConfiguration?.[activeSlot.id] : undefined

  return enabled ? (
    <aside
      className="pointer-events-auto fixed right-3 z-[110] flex w-[min(24rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-xl border border-border bg-background/80 text-foreground shadow-2xl backdrop-blur-md"
      style={{
        top: 'calc(var(--workspace-topbar-offset, 0px) + 0.75rem)',
        maxHeight: 'calc(100dvh - var(--workspace-topbar-offset, 0px) - 1.5rem)',
      }}
      aria-label="Character designer"
    >
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <p className="text-sm font-semibold">Character select</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Build a look and watch it update live.
          </p>
        </div>
        {onClose ? (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Close character designer"
            title="Close character designer"
            onClick={onClose}
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        ) : null}
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-3 py-3">
        <div
          className="flex shrink-0 gap-1 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          role="tablist"
          aria-label="Character categories"
        >
          <button
            type="button"
            role="tab"
            aria-label="Characters"
            title="Characters"
            aria-selected={activeCategory === 'characters'}
            className={cn(
              'flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background/30 text-muted-foreground transition-colors hover:border-primary/70 hover:bg-accent/70 hover:text-accent-foreground',
              activeCategory === 'characters' && 'border-primary bg-accent text-accent-foreground'
            )}
            onClick={() => setActiveCategory('characters')}
          >
            <UserRound className="size-4" aria-hidden="true" />
          </button>
          {characterDesignerSlotCategories.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-label={label}
              title={label}
              aria-selected={activeCategory === id}
              className={cn(
                'flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background/30 text-muted-foreground transition-colors hover:border-primary/70 hover:bg-accent/70 hover:text-accent-foreground',
                activeCategory === id && 'border-primary bg-accent text-accent-foreground'
              )}
              onClick={() => setActiveCategory(id)}
            >
              <Icon className="size-4" aria-hidden="true" />
            </button>
          ))}
        </div>
        <div className="flex min-h-0 flex-1 flex-col" role="tabpanel">
          <div className="mb-2 flex shrink-0 items-center justify-between">
            <p className="text-xs font-semibold">{activeSlot?.label ?? 'Characters'}</p>
            <span className="text-[10px] text-muted-foreground">
              {activeSlot ? `${activeParts.length} options` : 'choose a base'}
            </span>
          </div>
          <div
            className="min-h-0 flex-1 overflow-y-auto pr-1"
            role="radiogroup"
            data-model-thumbnail-root
            aria-label={activeSlot?.label ?? 'Characters'}
          >
            {activeSlot ? (
              <div className="grid grid-cols-3 gap-2">
                {activeSlot.id !== 'body' ? (
                  <ChoiceCard
                    label="None"
                    selected={selectedPart == null}
                    onClick={() => selectPart(activeSlot.id, null)}
                  >
                    <span className="flex aspect-square items-center justify-center rounded-lg bg-muted/60">
                      <CircleDot className="size-7 text-muted-foreground" aria-hidden="true" />
                    </span>
                  </ChoiceCard>
                ) : null}
                {activeParts.map((option) => (
                  <ChoiceCard
                    key={option.id}
                    label={option.label}
                    selected={selectedPart === option.id}
                    onClick={() => selectPart(activeSlot.id, option.id)}
                  >
                    <ModelThumbnail item={thumbnailItems.get(option.id)!} deferMs={3000} />
                  </ChoiceCard>
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {characterOptions.map((option) => {
                  const thumbnail = characterThumbnails.get(option.id)
                  return (
                    <ChoiceCard
                      key={option.id}
                      label={option.label}
                      selected={character === option.id}
                      onClick={() => selectCharacter(option.id)}
                    >
                      {thumbnail ? (
                        <ModelThumbnail item={thumbnail} deferMs={3000} />
                      ) : option.iconUrl ? (
                        <span className="flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-muted/60">
                          <img src={option.iconUrl} alt="" className="size-full object-contain" />
                        </span>
                      ) : (
                        <span className="flex aspect-square items-center justify-center rounded-lg bg-muted/60">
                          <Sparkles className="size-7 text-primary" aria-hidden="true" />
                        </span>
                      )}
                    </ChoiceCard>
                  )
                })}
              </div>
            )}
            {activeSlot && activeParts.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-3 py-5 text-center text-xs text-muted-foreground">
                No options in this category yet.
              </p>
            ) : null}
          </div>
        </div>
        <p className="sr-only" aria-live="polite">
          {status}
        </p>
      </div>
      <div className="grid shrink-0 grid-cols-2 gap-2 border-t border-border bg-background/85 p-3">
        <Button type="button" variant="secondary" disabled={!hasEdits} onClick={discard}>
          Reset design
        </Button>
        <Button type="button" variant="default" disabled={!hasEdits} onClick={() => void save()}>
          Save design
        </Button>
      </div>
    </aside>
  ) : null
}

function slotLabel(slot: CharacterPartSlot): string {
  return characterDesignerSlotCategories.find((category) => category.id === slot)?.label ?? slot
}
