import { literal, stringValue } from '../dev-runtime-validation-internal'
import type { RuntimeFailureRecord } from './failure'
import { validateFailureRecord } from './failure'
import {
  activityArray,
  activityCount,
  activityId,
  activityRecord,
  activityVersion,
  optionalComplete,
  optionalCounts,
  uniqueActivityId,
} from './validation'

export const runtimeTestStatuses = [
  'unknown',
  'pending',
  'running',
  'passed',
  'failed',
  'skipped',
  'cancelled',
] as const
export type RuntimeTestStatus = (typeof runtimeTestStatuses)[number]
export type RuntimeTestSummary = Readonly<{
  total?: number
  passed?: number
  failed?: number
  skipped?: number
  pending?: number
  durationMs?: number
}>
export type RuntimeTestSuite = Readonly<{
  suiteId: string
  name: string
  status: RuntimeTestStatus
  summary?: RuntimeTestSummary
  durationMs?: number
}>
export type RuntimeTestCase = Readonly<{
  testId: string
  name: string
  status: RuntimeTestStatus
  suiteId?: string
  durationMs?: number
  failureIds?: readonly string[]
}>
export type RuntimeTestRunPayload = Readonly<{
  schemaVersion: 1
  testRunId: string
  status: RuntimeTestStatus
  summary?: RuntimeTestSummary
  suites?: readonly RuntimeTestSuite[]
  tests?: readonly RuntimeTestCase[]
  failures?: readonly RuntimeFailureRecord[]
  complete?: boolean
}>

function validateSummary(value: unknown, path: string): void {
  const keys = ['total', 'passed', 'failed', 'skipped', 'pending', 'durationMs'] as const
  const item = activityRecord(value, path, [], keys)
  optionalCounts(item, keys, path)
}

export function validateTestRunPayload(value: unknown, path: string): void {
  const item = activityVersion(
    value,
    path,
    ['testRunId', 'status'],
    ['summary', 'suites', 'tests', 'failures', 'complete']
  )
  activityId(item.testRunId, `${path}.testRunId`)
  literal(item.status, runtimeTestStatuses, `${path}.status`)
  optionalComplete(item, path)
  if (item.summary !== undefined) validateSummary(item.summary, `${path}.summary`)
  if (item.suites !== undefined) {
    const seen = new Set<string>()
    for (const [index, entry] of activityArray(item.suites, `${path}.suites`, 64).entries()) {
      const location = `${path}.suites[${index}]`
      const suite = activityRecord(
        entry,
        location,
        ['suiteId', 'name', 'status'],
        ['summary', 'durationMs']
      )
      uniqueActivityId(seen, suite.suiteId, `${location}.suiteId`)
      stringValue(suite.name, `${location}.name`, 1, 512)
      literal(suite.status, runtimeTestStatuses, `${location}.status`)
      if (suite.summary !== undefined) validateSummary(suite.summary, `${location}.summary`)
      if (suite.durationMs !== undefined) activityCount(suite.durationMs, `${location}.durationMs`)
    }
  }
  if (item.tests !== undefined) {
    const seen = new Set<string>()
    for (const [index, entry] of activityArray(item.tests, `${path}.tests`, 256).entries()) {
      const location = `${path}.tests[${index}]`
      const row = activityRecord(
        entry,
        location,
        ['testId', 'name', 'status'],
        ['suiteId', 'durationMs', 'failureIds']
      )
      uniqueActivityId(seen, row.testId, `${location}.testId`)
      stringValue(row.name, `${location}.name`, 1, 512)
      literal(row.status, runtimeTestStatuses, `${location}.status`)
      if (row.suiteId !== undefined) activityId(row.suiteId, `${location}.suiteId`)
      if (row.durationMs !== undefined) activityCount(row.durationMs, `${location}.durationMs`)
      if (row.failureIds !== undefined) {
        const failureIds = new Set<string>()
        for (const failureId of activityArray(row.failureIds, `${location}.failureIds`, 64))
          uniqueActivityId(failureIds, failureId, `${location}.failureIds`)
      }
    }
  }
  if (item.failures !== undefined) {
    const seen = new Set<string>()
    for (const [index, failure] of activityArray(item.failures, `${path}.failures`, 64).entries()) {
      const location = `${path}.failures[${index}]`
      validateFailureRecord(failure, location)
      uniqueActivityId(seen, (failure as RuntimeFailureRecord).failureId, `${location}.failureId`)
    }
  }
}
