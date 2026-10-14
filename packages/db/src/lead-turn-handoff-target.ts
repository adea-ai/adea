/** Structured handoff target: the exact direct session this admission coordinates. */
export type HandoffTarget = Readonly<{
  runtimeSessionId: string
  taskId: string
  expectedGeneration: number
}>

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Validates the caller-supplied handoff target; the task itself is resolved server-side. */
export function parseHandoffTarget(value: unknown): HandoffTarget | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid lead turn')
  const record = value as Record<string, unknown>
  if (
    !Object.keys(record).every(
      (key) => key === 'runtimeSessionId' || key === 'taskId' || key === 'expectedGeneration'
    )
  )
    throw new Error('Invalid lead turn')
  const { runtimeSessionId, taskId, expectedGeneration } = record
  if (
    typeof runtimeSessionId !== 'string' ||
    !runtimeSessionId.trim() ||
    runtimeSessionId.trim().length > 256
  )
    throw new Error('Invalid lead turn')
  if (typeof taskId !== 'string' || !UUID_PATTERN.test(taskId)) throw new Error('Invalid lead turn')
  if (
    typeof expectedGeneration !== 'number' ||
    !Number.isSafeInteger(expectedGeneration) ||
    expectedGeneration < 0
  )
    throw new Error('Invalid lead turn')
  return {
    runtimeSessionId: runtimeSessionId.trim(),
    taskId: taskId.toLowerCase(),
    expectedGeneration,
  }
}
