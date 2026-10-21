import { cn } from '@adea-ai/app-ui/lib/utils'
import { paintWorkspaceAccent } from '@adea-ai/app-ui/components/workspace-accent'
import { useOptionalTheme } from '@adea-ai/ui/components/theme/lazy'
import { Circle, CircleAlert, GitPullRequest, LoaderCircle } from 'lucide-solid'
import { createEffect, createSignal, Match, Switch } from 'solid-js'

import { leafStatusLabel, type LeafStatus } from './model'
import { ProjectIcon } from './project-icon'

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

/**
 * A project row's icon. The project's own accent, when it has one, paints the
 * glyph; otherwise the glyph keeps the row's muted tone and the workspace
 * accent that surrounds the tree.
 */
export function ProjectGlyph(props: { iconKey?: string; accent?: string | null }) {
  const theme = useOptionalTheme()
  const [host, setHost] = createSignal<HTMLSpanElement>()
  createEffect(() => {
    const element = host()
    if (element) paintWorkspaceAccent(element, props.accent ?? null, theme)
  })
  return (
    <span ref={setHost} class={cn('flex', props.accent && 'text-primary')}>
      <ProjectIcon iconKey={props.iconKey} />
    </span>
  )
}
