import { z } from 'zod'
import { characterIds, isCharacterId, isCustomCharacterId } from './catalog'
export { characterConfigurationSchema, type CharacterConfiguration } from './configuration'

export const characterIdSchema = z.enum(characterIds)

export const customCharacterIdSchema = z.string().refine(isCustomCharacterId, {
  message: 'Unknown custom character id',
})

export const characterSelectionSchema = z
  .string()
  .refine((value) => isCharacterId(value) || isCustomCharacterId(value), {
    message: 'Unknown character id',
  })

export type ValidatedCharacterId = z.infer<typeof characterIdSchema>
