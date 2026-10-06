import { cn } from '@adea-ai/app-ui/lib/utils'
import {
  Circle,
  CircleAlert,
  Cloud,
  DoorOpen,
  Folder,
  FolderGit2,
  GitPullRequest,
  Hash,
  LoaderCircle,
} from 'lucide-solid'
import { Match, Switch } from 'solid-js'

import type { NavProjectIcon } from './adapters'
import { leafStatusLabel, type LeafStatus } from './model'

/**
 * A leaf's status as a glyph plus its words. The glyph is decorative; the
 * visually hidden label carries the meaning, so colour is never the only
 * signal.
 */
export function LeafStatusIcon(props: { status: LeafStatus; class?: string }) {
  return (
    <>
      <Switch>
        <Match when={props.status === 'running'}>
          <LoaderCircle
            aria-hidden="true"
            class={cn('text-primary animate-spin motion-reduce:animate-none', props.class)}
          />
        </Match>
        <Match when={props.status === 'needs_you'}>
          <CircleAlert aria-hidden="true" class={cn('text-warning', props.class)} />
        </Match>
        <Match when={props.status === 'in_review'}>
          <GitPullRequest aria-hidden="true" class={cn('text-info', props.class)} />
        </Match>
        <Match when={props.status === 'idle'}>
          <Circle aria-hidden="true" class={cn('scale-50 text-muted-foreground', props.class)} />
        </Match>
      </Switch>
      <span class="visually-hidden">{leafStatusLabel[props.status]}</span>
    </>
  )
}

export function ProjectIcon(props: { icon: NavProjectIcon }) {
  return (
    <Switch>
      <Match when={props.icon === 'git-folder'}>
        <FolderGit2 aria-hidden="true" />
      </Match>
      <Match when={props.icon === 'folder'}>
        <Folder aria-hidden="true" />
      </Match>
      <Match when={props.icon === 'cloud'}>
        <Cloud aria-hidden="true" />
      </Match>
      <Match when={props.icon === 'door'}>
        <DoorOpen aria-hidden="true" />
      </Match>
      <Match when={props.icon === 'hash'}>
        <Hash aria-hidden="true" />
      </Match>
    </Switch>
  )
}
