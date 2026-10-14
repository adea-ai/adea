// Small row parts the History pane's Turns, search and All sessions views share.
import { For, Show, createMemo, type JSX } from 'solid-js'

import {
  conversationSearchRowLabel,
  type ConversationSearchJump,
  type ConversationSearchKind,
  type ConversationSearchRow,
} from '../chat/search'
import { formatRelativeTime } from './turns-model'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Text } from '@adea-ai/ui/components/ui/typography'

export const KIND_LABELS: Record<ConversationSearchKind, string> = {
  prompt: 'Prompt',
  result: 'Reply',
  tool: 'Tool',
  approval: 'Approval',
  question: 'Question',
  status: 'Status',
  run: 'Run',
}

export function Highlighted(props: { text: string; query: string }): JSX.Element {
  const parts = createMemo(() => {
    const needle = props.query.trim()
    if (needle.length === 0) return [{ text: props.text, match: false }]
    const lower = props.text.toLocaleLowerCase()
    const target = needle.toLocaleLowerCase()
    const out: { text: string; match: boolean }[] = []
    let from = 0
    for (let at = lower.indexOf(target); at !== -1; at = lower.indexOf(target, from)) {
      if (at > from) out.push({ text: props.text.slice(from, at), match: false })
      out.push({ text: props.text.slice(at, at + target.length), match: true })
      from = at + target.length
    }
    if (from < props.text.length) out.push({ text: props.text.slice(from), match: false })
    return out
  })
  return (
    <For each={parts()}>
      {(part) =>
        part.match ? <mark class="bg-primary-subtle text-foreground">{part.text}</mark> : part.text
      }
    </For>
  )
}

// Plain list rows: the shared Item and Tabs compositions pull their own
// primitives into the utility host for what is a bordered list and a switch.
export function EntryList(props: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <ul role="list" aria-label={props.label} class="m-0 flex list-none flex-col gap-2 p-0">
      {props.children}
    </ul>
  )
}

export function Entry(props: {
  id?: string
  highlighted?: boolean
  trailing?: JSX.Element
  children: JSX.Element
}): JSX.Element {
  return (
    <li
      id={props.id}
      class="flex items-start gap-2 rounded-md border border-border p-2 data-revealed:border-ring data-revealed:ring-2 data-revealed:ring-ring"
      data-revealed={props.highlighted ? '' : undefined}
    >
      <div class="min-w-0 flex-1">{props.children}</div>
      {props.trailing}
    </li>
  )
}

export function ResultRow(props: {
  row: ConversationSearchRow
  query: string
  nowMs: number
  onGo?: ((jump: ConversationSearchJump) => void) | undefined
}): JSX.Element {
  return (
    <Entry
      trailing={
        <Show when={props.onGo}>
          {(go) => (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-history-go=""
              aria-label={`Go to ${conversationSearchRowLabel(props.row)}`}
              onClick={() => go()(props.row.jump)}
            >
              Go to
            </Button>
          )}
        </Show>
      }
    >
      <div class="flex min-w-0 flex-col gap-1.5">
        <div class="flex items-center gap-2">
          <Badge variant="outline">{KIND_LABELS[props.row.kind]}</Badge>
          <Show when={props.row.occurredAt}>
            {(at) => (
              <Text variant="caption" tone="muted" class="ms-auto">
                <time datetime={at()}>{formatRelativeTime(at(), props.nowMs)}</time>
              </Text>
            )}
          </Show>
        </div>
        <div class="line-clamp-3">
          <Text as="span" variant="body">
            <Highlighted text={props.row.preview} query={props.query} />
          </Text>
        </div>
      </div>
    </Entry>
  )
}
