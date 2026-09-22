import type { HarnessRun, RuntimeSession } from '@adea-ai/types/dev-runtime'

export type ChatNotificationKind = 'awaiting_input' | 'awaiting_approval' | 'completed'

export type ChatNotification = Readonly<{
  id: string
  kind: ChatNotificationKind
  runtimeSessionId: string
  title: string
  body: string
  generation: number
}>

export type ChatNotificationInput = Readonly<{
  currentRuns: readonly HarnessRun[]
  previousRuns: readonly HarnessRun[]
  sessions: readonly RuntimeSession[]
  focusedSessionId?: string
  windowFocused: boolean
  /** A background terminal owns attention while its session is active. */
  authoritySessionId?: string
}>

function safeTitle(session: RuntimeSession | undefined, sessionId: string): string {
  const title = session?.displayName?.trim()
  if (!title) return `Conversation ${sessionId.slice(0, 8)}`
  return title
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[secret redacted]')
    .replace(/\b(?:token|secret|password)[-_:=][^\s]+/gi, '[secret redacted]')
    .replace(/(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^\s`"']+/g, '[private path]')
    .slice(0, 120)
}

function notificationFor(
  run: HarnessRun,
  session: RuntimeSession | undefined,
  kind: ChatNotificationKind
): ChatNotification {
  const labels: Record<ChatNotificationKind, string> = {
    awaiting_input: 'Conversation needs your input',
    awaiting_approval: 'Conversation needs approval',
    completed: 'Conversation completed',
  }
  return {
    id: `${run.id}:${run.version}:${kind}`,
    kind,
    runtimeSessionId: run.runtimeSessionId,
    title: safeTitle(session, run.runtimeSessionId),
    body: labels[kind],
    generation: run.generation,
  }
}

/**
 * Derive desktop notification intents from a canonical before/after run
 * snapshot. The caller owns focus and delivery; this function retains no
 * watcher state and emits no prompt, tool, credential, or path content.
 */
export function deriveChatNotifications(input: ChatNotificationInput): readonly ChatNotification[] {
  const previous = new Map(input.previousRuns.map((run) => [run.id, run]))
  const sessions = new Map(input.sessions.map((session) => [session.id, session]))
  const notifications: ChatNotification[] = []
  if (input.windowFocused && input.focusedSessionId !== undefined) return notifications
  for (const run of input.currentRuns) {
    const before = previous.get(run.id)
    if (!before || before.state === run.state) continue
    if (run.runtimeSessionId === input.authoritySessionId) continue
    const kind: ChatNotificationKind | undefined =
      run.state === 'awaiting_input'
        ? 'awaiting_input'
        : run.state === 'awaiting_approval'
          ? 'awaiting_approval'
          : run.state === 'completed'
            ? 'completed'
            : undefined
    if (kind) notifications.push(notificationFor(run, sessions.get(run.runtimeSessionId), kind))
  }
  return notifications
}

export type DesktopNotificationSink = (notification: ChatNotification) => void

/** Deliver derived intents to an injected desktop bridge without storing them. */
export function publishChatNotifications(
  input: ChatNotificationInput,
  sink: DesktopNotificationSink
): number {
  const notifications = deriveChatNotifications(input)
  for (const notification of notifications) sink(notification)
  return notifications.length
}
