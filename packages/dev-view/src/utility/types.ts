import type { DevSessionBadgeState } from '../sidebar/badges'

export type DevProjectFixture = Readonly<{
  id: string
  name: string
  repository: string
  branch: string
  sessions: readonly Readonly<{
    id: string
    title: string
    state:
      | 'preparing'
      | 'ready'
      | 'active'
      | 'disconnected'
      | 'completed'
      | 'failed'
      | 'cancelled'
      | 'archived'
    generation?: number
    badges?: DevSessionBadgeState
  }>[]
}>

export type DevGroupFixture = Readonly<{
  id: string
  name: string
  projects: readonly DevProjectFixture[]
}>
