/*
 * Copyright (c) 2026 Michael Yong
 * SPDX-License-Identifier: MIT
 *
 * Versioned round-trip and failure behavior are substantially translated from
 * get-bb/bb apps/app/src/lib/split-layout/persistence.ts (MIT), revision
 * 52a9256373d4d36f9b60e9e2a7f333464091a2ac. Modified for strict binary,
 * authority-scoped Adea preferences and unread-value retention.
 * See NOTICE and docs/research/dev-view-donor-audit.md.
 */
import type { DevLayoutPreferencesV1, PaneNode, Scope } from '@adea-ai/types/dev-runtime'

import { MAX_LAYOUT_DEPTH, MAX_LAYOUT_LEAVES, MAX_SPLIT_RATIO, MIN_SPLIT_RATIO } from './operations'

export type LayoutDecodeResult =
  | Readonly<{ state: 'ready'; value: DevLayoutPreferencesV1 }>
  | Readonly<{ state: 'corrupt'; raw: string }>
  | Readonly<{ state: 'unsupported'; raw: string }>

const utilities = ['files', 'source_control', 'browser', 'devices', 'agents', 'history'] as const
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  const allowed = new Set([...required, ...optional])
  return (
    required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key))
  )
}

function decodeScope(value: unknown): value is Scope {
  return (
    isRecord(value) &&
    exactKeys(value, ['accountId', 'workspaceId', 'runtimeNodeId']) &&
    typeof value.accountId === 'string' &&
    typeof value.workspaceId === 'string' &&
    typeof value.runtimeNodeId === 'string' &&
    uuidPattern.test(value.accountId) &&
    uuidPattern.test(value.workspaceId) &&
    uuidPattern.test(value.runtimeNodeId)
  )
}

function decodeNode(
  value: unknown,
  ids: Set<string>,
  seen: Set<object>,
  depth: number,
  leaves: { count: number }
): value is PaneNode {
  if (!isRecord(value) || seen.has(value) || depth > MAX_LAYOUT_DEPTH) return false
  seen.add(value)
  if (typeof value.id !== 'string' || !value.id || ids.has(value.id)) return false
  ids.add(value.id)
  if (value.kind === 'leaf') {
    if (!exactKeys(value, ['kind', 'id', 'pane'], ['resourceId'])) return false
    if (value.pane !== 'terminal' && value.pane !== 'editor') return false
    if (value.resourceId !== undefined && typeof value.resourceId !== 'string') return false
    leaves.count += 1
    return leaves.count <= MAX_LAYOUT_LEAVES
  }
  if (value.kind !== 'split') return false
  if (!exactKeys(value, ['kind', 'id', 'direction', 'ratio', 'children'])) return false
  if (value.direction !== 'row' && value.direction !== 'column') return false
  if (
    typeof value.ratio !== 'number' ||
    !Number.isFinite(value.ratio) ||
    value.ratio < MIN_SPLIT_RATIO ||
    value.ratio > MAX_SPLIT_RATIO
  )
    return false
  if (!Array.isArray(value.children) || value.children.length !== 2) return false
  return (
    decodeNode(value.children[0], ids, seen, depth + 1, leaves) &&
    decodeNode(value.children[1], ids, seen, depth + 1, leaves)
  )
}

function decodePreferences(value: unknown): value is DevLayoutPreferencesV1 {
  if (!isRecord(value)) return false
  if (
    !exactKeys(
      value,
      ['schemaVersion', 'scope', 'projectId', 'runtimeSessionId', 'center', 'utility', 'focusMode'],
      ['focusTargetId']
    ) ||
    value.schemaVersion !== 1 ||
    !decodeScope(value.scope) ||
    typeof value.projectId !== 'string' ||
    !value.projectId ||
    typeof value.runtimeSessionId !== 'string' ||
    !value.runtimeSessionId ||
    typeof value.focusMode !== 'boolean' ||
    (value.focusTargetId !== undefined && typeof value.focusTargetId !== 'string')
  )
    return false

  const ids = new Set<string>()
  if (!decodeNode(value.center, ids, new Set(), 1, { count: 0 })) return false
  if (value.focusTargetId !== undefined && !ids.has(value.focusTargetId)) return false
  if (!Array.isArray(value.utility) || value.utility.length > utilities.length) return false
  const seenUtilities = new Set<string>()
  return value.utility.every((entry) => {
    if (
      !isRecord(entry) ||
      !exactKeys(entry, ['pane', 'side', 'visible', 'size', 'lastNonzeroSize'])
    )
      return false
    if (
      typeof entry.pane !== 'string' ||
      !utilities.includes(entry.pane as (typeof utilities)[number]) ||
      seenUtilities.has(entry.pane)
    )
      return false
    seenUtilities.add(entry.pane)
    return (
      (entry.side === 'left' || entry.side === 'right') &&
      typeof entry.visible === 'boolean' &&
      typeof entry.size === 'number' &&
      Number.isFinite(entry.size) &&
      entry.size >= 0 &&
      typeof entry.lastNonzeroSize === 'number' &&
      Number.isFinite(entry.lastNonzeroSize) &&
      entry.lastNonzeroSize > 0
    )
  })
}

export function decodeLayoutPreferences(raw: string): LayoutDecodeResult {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { state: 'corrupt', raw }
  }
  if (isRecord(value) && value.schemaVersion !== 1) return { state: 'unsupported', raw }
  return decodePreferences(value) ? { state: 'ready', value } : { state: 'corrupt', raw }
}

export function serializeLayoutPreferences(value: DevLayoutPreferencesV1): string {
  const decoded = decodeLayoutPreferences(JSON.stringify(value))
  if (decoded.state !== 'ready')
    throw new TypeError('corrupt_state: invalid Dev layout preferences')
  return JSON.stringify(decoded.value)
}

export function layoutStorageKey(
  scope: Scope,
  projectId: string,
  runtimeSessionId: string
): string {
  return `adea.dev-layout.v1:${[
    scope.accountId,
    scope.workspaceId,
    scope.runtimeNodeId,
    projectId,
    runtimeSessionId,
  ]
    .map(encodeURIComponent)
    .join(':')}`
}
