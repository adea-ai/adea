import {
  BedDouble,
  BookOpen,
  Briefcase,
  ClipboardList,
  Dumbbell,
  Gamepad2,
  Leaf,
  Megaphone,
  MessagesSquare,
  Music,
  Palette,
  Plane,
  Shapes,
  Utensils,
  Wrench,
} from 'lucide-react'

export function roomIconFor(functionKey: string) {
  const key = functionKey.toLowerCase()
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
  return Shapes
}

export function RoomIcon({ functionKey }: Readonly<{ functionKey: string }>) {
  const Icon = roomIconFor(functionKey)
  return <Icon aria-hidden="true" />
}
