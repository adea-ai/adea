/* Small shared pieces: people, status chips, change counts, and the
 * loading/empty/error states every region needs. Provider text renders as
 * Solid text nodes only. */
import type { GitHubActor, GitHubCheckRollupState } from '@adea-ai/types/dev-runtime'
import { cn } from '@adea-ai/app-ui/lib/utils'
import { Avatar, AvatarFallback } from '@adea-ai/ui/components/ui/avatar'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@adea-ai/ui/components/ui/empty'
import { EntityIcon } from '@adea-ai/ui/components/ui/entity-icon'
import { Skeleton } from '@adea-ai/ui/components/ui/skeleton'
import { StatusChip } from '@adea-ai/ui/components/ui/status-chip'
import { Bot } from 'lucide-solid'
import { For, Show, type Component, type JSX } from 'solid-js'

import { changeCounts, displayLogin, initial } from '../model/format'
import type { Facet } from '../model/status'
import type { Tone } from '../model/types'

/** A person's monogram, or for an agent a tinted bot mark, so an agent
 *  reads as one at a glance even where no badge fits. Decorative: the
 *  login beside it is the accessible name. */
export function PersonAvatar(props: {
  login: string
  agent?: boolean
  size?: 'xs' | 'sm' | 'md'
}): JSX.Element {
  return (
    <Show
      when={props.agent}
      fallback={
        <Avatar size={props.size ?? 'xs'} aria-hidden="true">
          <AvatarFallback content={initial(props.login)} />
        </Avatar>
      }
    >
      <EntityIcon
        name={displayLogin(props.login)}
        shape="circle"
        tone="primary"
        size={props.size ?? 'xs'}
        icon={Bot}
        aria-hidden="true"
      />
    </Show>
  )
}

export function Person(props: {
  actor?: GitHubActor
  agent?: boolean
  size?: 'xs' | 'sm' | 'md'
  showName?: boolean
}): JSX.Element {
  const login = () => props.actor?.login ?? 'ghost'
  const agent = () => Boolean(props.agent || props.actor?.kind === 'bot')
  return (
    <span class="dev-scm-person">
      <PersonAvatar login={login()} agent={agent()} {...(props.size ? { size: props.size } : {})} />
      <Show when={props.showName !== false}>
        <span class="dev-scm-truncate">{displayLogin(login())}</span>
      </Show>
      <Show when={agent()}>
        <Badge size="sm" variant="info">
          Agent
        </Badge>
      </Show>
    </span>
  )
}

/** The small tinted mark leading a timeline event: what happened, as an
 *  icon, with the tone of its outcome. Decorative; the sentence carries it. */
export function EventMark(props: {
  icon: Component
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info'
  label: string
}): JSX.Element {
  return (
    <EntityIcon
      name={props.label}
      shape="circle"
      size="sm"
      tone={props.tone ?? 'neutral'}
      icon={props.icon}
      aria-hidden="true"
    />
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

export const rollupLabel: Record<GitHubCheckRollupState, string> = {
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
  /** Drop the add/delete colours, for a file the reviewer has viewed. */
  muted?: boolean
}): JSX.Element {
  const counts = () => changeCounts(props.additions, props.deletions)
  return (
    <span
      class={cn('dev-scm-numbers', { 'dev-scm-numbers--muted': props.muted })}
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
