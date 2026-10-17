import { fail, literal, stringValue } from '../dev-runtime-validation-internal'
import {
  activityArray,
  activityCount,
  activityId,
  activityPath,
  activityRecord,
  activityUrl,
  activityVersion,
  optionalComplete,
  optionalCounts,
  optionalText,
  uniqueActivityId,
} from './validation'

export const runtimeWorkStatuses = [
  'unknown',
  'pending',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
] as const
export type RuntimeWorkStatus = (typeof runtimeWorkStatuses)[number]
export type RuntimeWorkItem = Readonly<{
  id: string
  title: string
  status: RuntimeWorkStatus
  description?: string
}>
export type RuntimePlanPayload = Readonly<{
  schemaVersion: 1
  planId: string
  status: RuntimeWorkStatus
  title?: string
  items: readonly RuntimeWorkItem[]
  summary?: Readonly<{
    total?: number
    pending?: number
    inProgress?: number
    completed?: number
    failed?: number
    cancelled?: number
  }>
  complete?: boolean
}>
export type RuntimeTaskPayload = Readonly<{
  schemaVersion: 1
  taskId: string
  title: string
  status: RuntimeWorkStatus
  description?: string
  parentTaskId?: string
  planId?: string
  todos?: readonly RuntimeWorkItem[]
  url?: string
}>
export const runtimeFileChangeKinds = [
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'untracked',
] as const
export type RuntimeFileChange = Readonly<{
  path: string
  change: (typeof runtimeFileChangeKinds)[number]
  previousPath?: string
  additions?: number
  deletions?: number
}>
export type RuntimeChangedFilesPayload = Readonly<{
  schemaVersion: 1
  changeSetId: string
  files: readonly RuntimeFileChange[]
  complete?: boolean
  summary?: Readonly<{ files?: number; additions?: number; deletions?: number }>
}>

function validateItems(value: unknown, path: string): void {
  const seen = new Set<string>()
  for (const [index, entry] of activityArray(value, path, 128).entries()) {
    const location = `${path}[${index}]`
    const item = activityRecord(entry, location, ['id', 'title', 'status'], ['description'])
    uniqueActivityId(seen, item.id, `${location}.id`)
    stringValue(item.title, `${location}.title`, 1, 512)
    literal(item.status, runtimeWorkStatuses, `${location}.status`)
    optionalText(item, 'description', location, 4096)
  }
}

export function validatePlanPayload(value: unknown, path: string): void {
  const item = activityVersion(
    value,
    path,
    ['planId', 'status', 'items'],
    ['title', 'summary', 'complete']
  )
  activityId(item.planId, `${path}.planId`)
  literal(item.status, runtimeWorkStatuses, `${path}.status`)
  optionalText(item, 'title', path, 512)
  validateItems(item.items, `${path}.items`)
  optionalComplete(item, path)
  if (item.summary !== undefined) {
    const keys = ['total', 'pending', 'inProgress', 'completed', 'failed', 'cancelled']
    const summary = activityRecord(item.summary, `${path}.summary`, [], keys)
    optionalCounts(summary, keys, `${path}.summary`)
  }
}

export function validateTaskPayload(value: unknown, path: string): void {
  const item = activityVersion(
    value,
    path,
    ['taskId', 'title', 'status'],
    ['description', 'parentTaskId', 'planId', 'todos', 'url']
  )
  activityId(item.taskId, `${path}.taskId`)
  stringValue(item.title, `${path}.title`, 1, 512)
  literal(item.status, runtimeWorkStatuses, `${path}.status`)
  optionalText(item, 'description', path, 4096)
  for (const key of ['parentTaskId', 'planId'] as const)
    if (item[key] !== undefined) activityId(item[key], `${path}.${key}`)
  if (item.parentTaskId === item.taskId) fail(`${path}.parentTaskId`, 'a task cannot parent itself')
  if (item.todos !== undefined) validateItems(item.todos, `${path}.todos`)
  if (item.url !== undefined) activityUrl(item.url, `${path}.url`)
}

export function validateChangedFilesPayload(value: unknown, path: string): void {
  const item = activityVersion(value, path, ['changeSetId', 'files'], ['complete', 'summary'])
  activityId(item.changeSetId, `${path}.changeSetId`)
  optionalComplete(item, path)
  const seen = new Set<string>()
  for (const [index, entry] of activityArray(item.files, `${path}.files`, 256).entries()) {
    const location = `${path}.files[${index}]`
    const file = activityRecord(
      entry,
      location,
      ['path', 'change'],
      ['previousPath', 'additions', 'deletions']
    )
    const filePath = activityPath(file.path, `${location}.path`)
    if (seen.has(filePath)) fail(`${location}.path`, 'duplicate changed path')
    seen.add(filePath)
    literal(file.change, runtimeFileChangeKinds, `${location}.change`)
    if (file.change === 'renamed' || file.change === 'copied') {
      const previous = activityPath(file.previousPath, `${location}.previousPath`)
      if (previous === filePath) fail(`${location}.previousPath`, 'must differ from the new path')
    } else if (file.previousPath !== undefined)
      fail(`${location}.previousPath`, 'requires renamed or copied change')
    for (const key of ['additions', 'deletions'] as const)
      if (file[key] !== undefined) activityCount(file[key], `${location}.${key}`)
  }
  if (item.summary !== undefined) {
    const keys = ['files', 'additions', 'deletions']
    const summary = activityRecord(item.summary, `${path}.summary`, [], keys)
    optionalCounts(summary, keys, `${path}.summary`)
  }
}
