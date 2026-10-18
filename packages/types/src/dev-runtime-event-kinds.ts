// Shared discriminators only; payload validation stays in the complete contract modules.
export const runtimeCallEventKinds = [
  'tool.requested',
  'tool.started',
  'tool.progress',
  'tool.completed',
  'tool.failed',
  'subagent.observed',
] as const
export type RuntimeCallEventKind = (typeof runtimeCallEventKinds)[number]
export function isRuntimeCallEventKind(kind: unknown): kind is RuntimeCallEventKind {
  return runtimeCallEventKinds.includes(kind as RuntimeCallEventKind)
}

export const runtimeActivityEventKinds = [
  'test_run.observed',
  'terminal.output',
  'failure.observed',
  'files.changed',
  'plan.observed',
  'task.observed',
] as const
export type RuntimeActivityEventKind = (typeof runtimeActivityEventKinds)[number]
export function isRuntimeActivityEventKind(value: unknown): value is RuntimeActivityEventKind {
  return runtimeActivityEventKinds.includes(value as RuntimeActivityEventKind)
}
