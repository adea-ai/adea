import { fail, literal, stringValue } from '../dev-runtime-validation-internal'
import {
  activityArray,
  activityCount,
  activityId,
  activityPath,
  activityRecord,
  activityUrl,
  activityVersion,
  optionalText,
} from './validation'

export type RuntimeStackFrame = Readonly<{
  functionName?: string
  path?: string
  url?: string
  line?: number
  column?: number
  native?: boolean
}>
export type RuntimeStackTrace = Readonly<{ frames: readonly RuntimeStackFrame[]; raw?: string }>
export type RuntimeFailureRecord = Readonly<{
  failureId: string
  message: string
  name?: string
  testId?: string
  stack?: RuntimeStackTrace
}>
export type RuntimeFailurePayload = RuntimeFailureRecord & Readonly<{ schemaVersion: 1 }>

function validateStack(value: unknown, path: string): void {
  const item = activityRecord(value, path, ['frames'], ['raw'])
  optionalText(item, 'raw', path, 16_384)
  for (const [index, frame] of activityArray(item.frames, `${path}.frames`, 64).entries()) {
    const location = `${path}.frames[${index}]`
    const row = activityRecord(
      frame,
      location,
      [],
      ['functionName', 'path', 'url', 'line', 'column', 'native']
    )
    optionalText(row, 'functionName', location, 512)
    if (row.path !== undefined) activityPath(row.path, `${location}.path`)
    if (row.url !== undefined) activityUrl(row.url, `${location}.url`)
    if (row.path !== undefined && row.url !== undefined)
      fail(location, 'frame has ambiguous path and URL')
    if (row.native !== undefined) literal(row.native, [true, false], `${location}.native`)
    if (
      row.functionName === undefined &&
      row.path === undefined &&
      row.url === undefined &&
      row.native !== true
    )
      fail(location, 'frame requires an observed function, location or native fact')
    for (const key of ['line', 'column'] as const) {
      if (row[key] !== undefined) {
        if (row.path === undefined && row.url === undefined)
          fail(`${location}.${key}`, 'requires a frame location')
        if (activityCount(row[key], `${location}.${key}`) === 0)
          fail(`${location}.${key}`, 'expected positive location')
      }
    }
    if (row.column !== undefined && row.line === undefined)
      fail(`${location}.line`, 'required with column')
  }
}

export function validateFailureRecord(value: unknown, path: string, versioned = false): void {
  const item = versioned
    ? activityVersion(value, path, ['failureId', 'message'], ['name', 'testId', 'stack'])
    : activityRecord(value, path, ['failureId', 'message'], ['name', 'testId', 'stack'])
  activityId(item.failureId, `${path}.failureId`)
  stringValue(item.message, `${path}.message`, 1, 8192)
  optionalText(item, 'name', path, 256)
  if (item.testId !== undefined) activityId(item.testId, `${path}.testId`)
  if (item.stack !== undefined) validateStack(item.stack, `${path}.stack`)
}
