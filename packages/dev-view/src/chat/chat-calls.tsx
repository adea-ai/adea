import { createMemo, For, Show, type JSX } from 'solid-js'
import { CodeBlock } from '@adea-ai/ui/components/ui/code-block'
import { Trace, TraceDetail, TraceLine, type TraceStatus } from '@adea-ai/ui/components/ui/trace'
import { formatDuration } from '@adea-ai/ui/components/composites/reasoning'
import { Subagent } from '@adea-ai/ui/components/composites/subagent'
import { Tool, type ToolStatus } from '@adea-ai/ui/components/composites/tool'

import type { ChatTurnCall } from './model/turns'
import type { ChatCall, ChatCallData } from './presentation'

const isTerminalPhase = (phase: ChatCall['phase']) =>
  phase === 'completed' || phase === 'failed' || phase === 'cancelled'

/**
 * What the producer's phase lets the mark say. A started or progressing call is the
 * producer's last word, not a fact about now: it animates only while the session is
 * working, and a call that was left mid-flight shows no mark, with "not finished" in
 * its place. The payload's permission eligibility is an observation, never a grant,
 * so it is not read here.
 */
function callStatus(call: ChatCall, live: boolean): ToolStatus | undefined {
  switch (call.phase) {
    case 'completed':
      return 'success'
    case 'failed':
      return 'error'
    case 'cancelled':
      return 'cancelled'
    case 'requested':
      return live ? 'pending' : undefined
    default:
      return live ? 'running' : undefined
  }
}

function callMeta(call: ChatCall, live: boolean, duration = true): string | undefined {
  const parts: string[] = []
  if (!isTerminalPhase(call.phase) && !live) parts.push('not finished')
  else if (call.phase === 'requested') parts.push('requested')
  if (duration && isTerminalPhase(call.phase) && call.durationMs !== undefined)
    parts.push(formatDuration(call.durationMs / 1000) ?? '')
  const words = parts.filter(Boolean).join(' · ')
  return words.length > 0 ? words : undefined
}

/** The shared Tool shows the text it is given; this says what it was not given. */
function dataNote(label: string, data: ChatCallData | undefined): string | undefined {
  if (data === undefined) return undefined
  if (data.type === 'reference')
    return `${label} is held by reference${
      data.byteLength !== undefined ? ` (${data.byteLength} bytes)` : ''
    } and is not shown here.`
  return data.truncated ? `${label} is shortened for display.` : undefined
}

const inlineText = (data: ChatCallData | undefined): string | undefined =>
  data?.type === 'inline' ? data.text : undefined

function CallNotes(props: { call: ChatCall }): JSX.Element {
  const notes = () =>
    [dataNote('Input', props.call.input), dataNote('Output', props.call.output)].filter(
      (note): note is string => note !== undefined
    )
  return <For each={notes()}>{(note) => <TraceDetail data-call-note="">{note}</TraceDetail>}</For>
}

/** The input a subagent was given, with what was not shown, as the first step of its body. */
function SubagentInput(props: { input: ChatCallData }): JSX.Element {
  return (
    <TraceLine title="Input" data-call-input="">
      <Show when={inlineText(props.input)}>
        {(text) => <CodeBlock code={text()} language="text" size="sm" wrap maxHeight="12rem" />}
      </Show>
      <Show when={dataNote('Input', props.input)}>
        {(note) => <TraceDetail data-call-note="">{note()}</TraceDetail>}
      </Show>
    </TraceLine>
  )
}

/** The answer a subagent returned, or the note that it was held back or shortened. */
function SubagentResult(props: { output: ChatCallData }): JSX.Element {
  return (
    <>
      <Show when={inlineText(props.output)}>
        {(text) => <CodeBlock code={text()} language="text" size="sm" wrap maxHeight="12rem" />}
      </Show>
      <Show when={dataNote('Output', props.output)}>
        {(note) => (
          <p class="m-0 text-muted-foreground" data-call-note="">
            {note()}
          </p>
        )}
      </Show>
    </>
  )
}

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, index) => id === b[index])

/** Calls a parent holds, kept by id so an open line survives the next snapshot. */
function CallLines(props: {
  entries: () => readonly ChatTurnCall[]
  live: () => boolean
}): JSX.Element {
  const ids = createMemo<readonly string[]>(() => props.entries().map((entry) => entry.id), [], {
    equals: sameIds,
  })
  const byId = createMemo(() => new Map(props.entries().map((entry) => [entry.id, entry])))
  return (
    <For each={ids()}>
      {(id) => (
        <Show when={byId().get(id)}>
          <CallLine entry={() => byId().get(id)!} live={props.live} />
        </Show>
      )}
    </For>
  )
}

/** A tool or subagent call the producer identified, with the calls it parented inside it. */
export function CallLine(props: { entry: () => ChatTurnCall; live: () => boolean }): JSX.Element {
  const call = () => props.entry().call
  const children = () => props.entry().children
  const common = () => ({
    'data-entry-id': props.entry().id,
    'data-event-id': props.entry().id,
    'data-kind': call().family === 'subagent' ? 'subagent.observed' : `tool.${call().phase}`,
    'data-call-phase': call().phase,
  })
  return (
    <Show
      when={call().family === 'subagent'}
      fallback={
        <Tool
          {...common()}
          name={call().name ?? 'Tool call'}
          status={callStatus(call(), props.live())}
          meta={callMeta(call(), props.live())}
          input={inlineText(call().input)}
          output={inlineText(call().output)}
        >
          <CallNotes call={call()} />
          <Show when={children().length > 0}>
            <Trace size="sm">
              <CallLines entries={children} live={props.live} />
            </Trace>
          </Show>
        </Tool>
      }
    >
      <Subagent
        {...common()}
        name={call().name ?? 'Subagent'}
        status={callStatus(call(), props.live()) as TraceStatus | undefined}
        meta={callMeta(call(), props.live(), false)}
        duration={
          isTerminalPhase(call().phase) && call().durationMs !== undefined
            ? call().durationMs! / 1000
            : undefined
        }
        // The input line is not a step the subagent took.
        stepCount={children().length}
        result={
          call().output === undefined ? undefined : <SubagentResult output={call().output!} />
        }
      >
        <Show when={call().input}>{(input) => <SubagentInput input={input()} />}</Show>
        <CallLines entries={children} live={props.live} />
      </Subagent>
    </Show>
  )
}
