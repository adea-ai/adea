import { isShellIconKey, resolveShellIcon } from '@adea-ai/ui/components/composites/icon-picker'
import {
  BedDouble,
  BookOpen,
  Briefcase,
  ClipboardList,
  Dumbbell,
  Folder,
  Gamepad2,
  Leaf,
  Megaphone,
  MessagesSquare,
  Music,
  Palette,
  Plane,
  Utensils,
  Wrench,
  type LucideIcon,
} from 'lucide-solid'
import { Dynamic } from 'solid-js/web'

/**
 * The icon a project wears. A key from the shell's curated set (what the
 * project settings picker stores) wins; older projects carry free-text keys
 * like "kitchen" or "engineering", which keep their themed glyph; anything else
 * is the folder every project starts with.
 */
export function projectIconFor(iconKey: string | undefined): LucideIcon {
  if (!iconKey) return Folder
  if (isShellIconKey(iconKey)) return resolveShellIcon(iconKey)
  const key = iconKey.toLowerCase()
  if (key.includes('kitchen') || key.includes('cook') || key.includes('dining')) return Utensils
  if (key.includes('study') || key.includes('librar') || key.includes('read')) return BookOpen
  if (key.includes('travel') || key.includes('trip') || key.includes('flight')) return Plane
  if (key.includes('engineer') || key.includes('build') || key.includes('dev')) return Wrench
  if (key.includes('market')) return Megaphone
  if (key.includes('operation') || key === 'ops' || key.includes('ops-')) return ClipboardList
  if (key.includes('music') || key.includes('audio')) return Music
  if (key.includes('garden') || key.includes('plant')) return Leaf
  if (key.includes('gym') || key.includes('fitness') || key.includes('health')) return Dumbbell
  if (key.includes('sleep') || key.includes('bed') || key.includes('rest')) return BedDouble
  if (key.includes('art') || key.includes('design') || key.includes('paint')) return Palette
  if (key.includes('game') || key.includes('play')) return Gamepad2
  if (key.includes('work') || key.includes('office')) return Briefcase
  if (key.includes('chat') || key.includes('talk') || key.includes('discuss')) return MessagesSquare
  return Folder
}

export function ProjectIcon(props: { iconKey?: string }) {
  return <Dynamic component={projectIconFor(props.iconKey)} aria-hidden="true" />
}
