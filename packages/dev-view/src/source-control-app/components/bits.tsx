/* Small shared pieces: people, status chips, change counts, and the
 * loading/empty/error states every region needs. Provider text renders as
 * Solid text nodes only. */
import type { GitHubActor, GitHubCheckRollupState } from '@adea-ai/types/dev-runtime'
import { Avatar, AvatarFallback } from '@adea-ai/ui/components/ui/avatar'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@adea-ai/ui/components/ui/empty'
import { Skeleton } from '@adea-ai/ui/components/ui/skeleton'
import { StatusChip } from '@adea-ai/ui/components/ui/status-chip'
import { For, Show, type JSX } from 'solid-js'

import { changeCounts, displayLogin, initial } from '../model/format'
import type { Facet } from '../model/status'
import type { Tone } from '../model/types'

export function Person(props: {
  actor?: GitHubActor
  agent?: boolean
  size?: 'xs' | 'sm' | 'md'
  showName?: boolean
}): JSX.Element {
  const login = () => props.actor?.login ?? 'ghost'
  return (
    <span class="dev-scm-person">
      <Avatar size={props.size ?? 'xs'} aria-hidden="true">
        <AvatarFallback content={initial(login())} />
      </Avatar>
      <Show when={props.showName !== false}>
        <span class="dev-scm-truncate">{displayLogin(login())}</span>
      </Show>
      <Show when={props.agent || props.actor?.kind === 'bot'}>
        <Badge size="sm" variant="info">
          Agent
        </Badge>
      </Show>
    </span>
  )
}

export function FacetChip(props: { facet: Facet; compact?: boolean }): JSX.Element {
  return (
    <StatusChip
      tone={props.facet.tone}
      label={props.facet.label}
      {...(props.facet.detail ? { detail: props.facet.detail } : {})}
      {...(props.compact ? { compact: true } : {})}
    />
  )
}

const rollupTone: Record<GitHubCheckRollupState, Tone> = {
  success: 'success',
  failure: 'danger',
  pending: 'info',
  none: 'unknown',
}

const rollupLabel: Record<GitHubCheckRollupState, string> = {
  success: 'Passing',
  failure: 'Failing',
  pending: 'Running',
  none: 'No checks',
}

export function RollupChip(props: {
  state: GitHubCheckRollupState
  compact?: boolean
  subject?: string
}): JSX.Element {
  return (
    <StatusChip
      tone={rollupTone[props.state]}
      label={
        props.subject
          ? `${props.subject} ${rollupLabel[props.state].toLowerCase()}`
          : rollupLabel[props.state]
      }
      {...(props.compact ? { compact: true } : {})}
    />
  )
}

export function ChangeCounts(props: {
  additions: number
  deletions: number
  class?: string
}): JSX.Element {
  const counts = () => changeCounts(props.additions, props.deletions)
  return (
    <span
      class="dev-scm-numbers"
      aria-label={`${props.additions} additions, ${props.deletions} deletions`}
    >
      <span class="dev-scm-add">{counts().add}</span>{' '}
      <span class="dev-scm-del">{counts().del}</span>
    </span>
  )
}

export function LoadingRows(props: { count?: number; label: string }): JSX.Element {
  return (
    <div class="dev-scm-inbox" role="status" aria-label={props.label}>
      <For each={Array.from({ length: props.count ?? 4 })}>
        {() => <Skeleton class="h-14 w-full" />}
      </For>
    </div>
  )
}

export function StateMessage(props: {
  title: string
  description?: string
  children?: JSX.Element
}): JSX.Element {
  return (
    <div class="dev-scm-state">
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{props.title}</EmptyTitle>
          <Show when={props.description}>
            <EmptyDescription>{props.description}</EmptyDescription>
          </Show>
        </EmptyHeader>
        {props.children}
      </Empty>
    </div>
  )
}
