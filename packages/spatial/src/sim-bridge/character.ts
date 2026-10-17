/**
 * The character value the bridge carries in `host.launch` and `frame.character.save`.
 *
 * Two forms, both finite and structurally checked. The bridge never learns the private part
 * catalog: slot contents are bounded opaque ids and the engine keeps validating membership.
 *
 * 1. A catalog id, such as `configurable`.
 * 2. `character:v1:` followed by exactly 13 `|`-separated slots in `SIM_CHARACTER_SLOTS` order.
 *    An empty slot is `-`, and `body` is required.
 */

export const SIM_CHARACTER_SLOTS = [
  'body',
  'ears',
  'face',
  'hair',
  'hat',
  'top',
  'bottom',
  'shoes',
  'socks',
  'glasses',
  'gloves',
  'accessory',
  'costume',
] as const

export const SIM_SERIALIZED_CHARACTER_PREFIX = 'character:v1:'
/** The audited serializer's longest value is 251 characters; this leaves headroom, not slack. */
export const MAX_SIM_SERIALIZED_CHARACTER_LENGTH = 384

const CATALOG_ID = /^[A-Za-z0-9_.:-]{1,64}$/
const SLOT_PART_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/
const EMPTY_SLOT = '-'

export function isSerializedSimCharacter(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length > MAX_SIM_SERIALIZED_CHARACTER_LENGTH ||
    !value.startsWith(SIM_SERIALIZED_CHARACTER_PREFIX)
  )
    return false
  const slots = value.slice(SIM_SERIALIZED_CHARACTER_PREFIX.length).split('|')
  if (slots.length !== SIM_CHARACTER_SLOTS.length) return false
  return slots.every((slot, index) => (slot === EMPTY_SLOT ? index !== 0 : SLOT_PART_ID.test(slot)))
}

/** The value when it is a catalog id or a well-formed serialized character; otherwise null. */
export function parseSimCharacterValue(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (value.startsWith('character:')) return isSerializedSimCharacter(value) ? value : null
  return CATALOG_ID.test(value) ? value : null
}
