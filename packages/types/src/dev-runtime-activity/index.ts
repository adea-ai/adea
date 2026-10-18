import {
  isRuntimeActivityEventKind,
  type RuntimeActivityEventKind,
} from '../dev-runtime-event-kinds'
export { runtimeActivityEventKinds, isRuntimeActivityEventKind } from '../dev-runtime-event-kinds'
export type { RuntimeActivityEventKind } from '../dev-runtime-event-kinds'
import { fail } from '../dev-runtime-validation-internal'
import { validateFailureRecord, type RuntimeFailurePayload } from './failure'
import { validateTestRunPayload, type RuntimeTestRunPayload } from './test-run'
import { validateTerminalPayload, type RuntimeTerminalOutputPayload } from './terminal'
import {
  validateChangedFilesPayload,
  validatePlanPayload,
  validateTaskPayload,
  type RuntimeChangedFilesPayload,
  type RuntimePlanPayload,
  type RuntimeTaskPayload,
} from './work'
import { assertActivityJsonBounds } from './validation'

export {
  ACTIVITY_PAYLOAD_BYTES_MAX,
  ACTIVITY_JSON_NODES_MAX,
  ACTIVITY_JSON_DEPTH_MAX,
  ACTIVITY_TEXT_MAX,
} from './validation'
export { runtimeTestStatuses } from './test-run'
export { runtimeWorkStatuses, runtimeFileChangeKinds } from './work'
export type {
  RuntimeFailureRecord,
  RuntimeFailurePayload,
  RuntimeStackFrame,
  RuntimeStackTrace,
} from './failure'
export type {
  RuntimeTestRunPayload,
  RuntimeTestSummary,
  RuntimeTestSuite,
  RuntimeTestCase,
  RuntimeTestStatus,
} from './test-run'
export type { RuntimeTerminalOutputPayload } from './terminal'
export type {
  RuntimeChangedFilesPayload,
  RuntimeFileChange,
  RuntimePlanPayload,
  RuntimeTaskPayload,
  RuntimeWorkStatus,
  RuntimeWorkItem,
} from './work'

export type RuntimeActivityPayloads = {
  'test_run.observed': RuntimeTestRunPayload
  'terminal.output': RuntimeTerminalOutputPayload
  'failure.observed': RuntimeFailurePayload
  'files.changed': RuntimeChangedFilesPayload
  'plan.observed': RuntimePlanPayload
  'task.observed': RuntimeTaskPayload
}

/** Validates claims without calculating counts, statuses, frames or missing content. */
export function decodeRuntimeActivityPayload<K extends RuntimeActivityEventKind>(
  value: unknown,
  kind: K
): RuntimeActivityPayloads[K] {
  if (!isRuntimeActivityEventKind(kind)) fail('event.kind', 'expected structured activity kind')
  const path = 'event.payload'
  assertActivityJsonBounds(value, path)
  switch (kind) {
    case 'test_run.observed':
      validateTestRunPayload(value, path)
      break
    case 'terminal.output':
      validateTerminalPayload(value, path)
      break
    case 'failure.observed':
      validateFailureRecord(value, path, true)
      break
    case 'files.changed':
      validateChangedFilesPayload(value, path)
      break
    case 'plan.observed':
      validatePlanPayload(value, path)
      break
    case 'task.observed':
      validateTaskPayload(value, path)
      break
  }
  return value as RuntimeActivityPayloads[K]
}
