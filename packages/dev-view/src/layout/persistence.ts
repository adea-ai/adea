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
import type {
  DevLayoutPreferencesV1,
  DevLayoutPreferencesV2,
  DevUtilityPane,
  DevUtilityPreference,
  PaneNode,
  Scope,
} from '@adea-ai/types/dev-runtime'

import {
  MAX_LAYOUT_DEPTH,
  MAX_LAYOUT_LEAVES,
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  listLeaves,
} from './operations'

export type LayoutDecodeResult =
  | Readonly<{ state: 'ready'; value: DevLayoutPreferencesV1 }>
  | Readonly<{ state: 'corrupt'; raw: string }>
  | Readonly<{ state: 'unsupported'; raw: string }>

export type LayoutDocumentResult =
  | Readonly<{ state: 'ready'; value: DevLayoutPreferencesV2; migrated: boolean }>
  | Readonly<{ state: 'corrupt'; raw: string }>
  | Readonly<{ state: 'unsupported'; raw: string }>

const utilities = ['files', 'source_control', 'browser', 'devices', 'agents', 'history'] as const
const canonicalUtilitySides: Readonly<Record<DevUtilityPane, 'left' | 'right'>> = {
  files: 'left',
  source_control: 'left',
  browser: 'right',
  devices: 'right',
  agents: 'right',
  history: 'right',
}
const defaultUtilitySize = 288
// The #447 V1 envelope encoded full width by inflating `size` past this mark.
const legacyFullWidthSize = 1000

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

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

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

/** The V1 storage key remains readable so the client can migrate #447 values. */
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

export function layoutStorageKeyV2(
  scope: Scope,
  projectId: string,
  runtimeSessionId: string
): string {
  return `adea.dev-layout.v2:${[
    scope.accountId,
    scope.workspaceId,
    scope.runtimeNodeId,
    projectId,
    runtimeSessionId,
  ]
    .map(encodeURIComponent)
    .join(':')}`
}

function isUtilityPane(value: unknown): value is DevUtilityPane {
  return typeof value === 'string' && utilities.includes(value as DevUtilityPane)
}

function decodeUtilityPreference(
  value: unknown,
  seenPanes: Set<string>,
  seenOrders: Set<number>,
  visiblePerSide: { left: number; right: number }
): value is DevUtilityPreference {
  if (!isRecord(value)) return false
  if (
    !exactKeys(value, ['pane', 'side', 'order', 'visible', 'size', 'lastNonzeroSize', 'fullWidth'])
  )
    return false
  if (!isUtilityPane(value.pane) || seenPanes.has(value.pane)) return false
  seenPanes.add(value.pane)
  if (value.side !== 'left' && value.side !== 'right') return false
  if (
    typeof value.order !== 'number' ||
    !Number.isInteger(value.order) ||
    value.order < 0 ||
    value.order >= utilities.length ||
    seenOrders.has(value.order)
  )
    return false
  seenOrders.add(value.order)
  if (typeof value.visible !== 'boolean' || typeof value.fullWidth !== 'boolean') return false
  if (value.visible) visiblePerSide[value.side] += 1
  return (
    visiblePerSide[value.side] <= 1 &&
    typeof value.size === 'number' &&
    Number.isFinite(value.size) &&
    value.size >= 0 &&
    typeof value.lastNonzeroSize === 'number' &&
    Number.isFinite(value.lastNonzeroSize) &&
    value.lastNonzeroSize > 0
  )
}

function decodePreferencesV2(value: unknown): DevLayoutPreferencesV2 | undefined {
  if (!isRecord(value)) return undefined
  if (
    value.schemaVersion !== 2 ||
    !exactKeys(
      value,
      ['schemaVersion', 'scope', 'projectId', 'runtimeSessionId', 'center', 'utility', 'focusMode'],
      ['focusTargetId']
    ) ||
    !decodeScope(value.scope) ||
    typeof value.projectId !== 'string' ||
    !value.projectId ||
    typeof value.runtimeSessionId !== 'string' ||
    !value.runtimeSessionId ||
    typeof value.focusMode !== 'boolean' ||
    (value.focusTargetId !== undefined && typeof value.focusTargetId !== 'string')
  )
    return undefined

  const ids = new Set<string>()
  if (!decodeNode(value.center, ids, new Set(), 1, { count: 0 })) return undefined
  if (!Array.isArray(value.utility) || value.utility.length !== utilities.length) return undefined
  const seenPanes = new Set<string>()
  const seenOrders = new Set<number>()
  const visiblePerSide = { left: 0, right: 0 }
  const utility = value.utility.map((entry) => {
    if (!decodeUtilityPreference(entry, seenPanes, seenOrders, visiblePerSide)) return undefined
    return entry as DevUtilityPreference
  })
  if (utility.some((entry) => entry === undefined) || seenPanes.size !== utilities.length)
    return undefined
  // Focus is normalized, never rejected: a stale, missing, or split-node
  // target falls back to the first center leaf so every restored document
  // keeps one valid focus target.
  const leafIds = new Set(listLeaves(value.center).map((leaf) => leaf.id))
  const focusTargetId =
    typeof value.focusTargetId === 'string' && leafIds.has(value.focusTargetId)
      ? value.focusTargetId
      : listLeaves(value.center)[0]!.id
  return {
    schemaVersion: 2,
    scope: value.scope,
    projectId: value.projectId,
    runtimeSessionId: value.runtimeSessionId,
    center: value.center,
    utility: utility as unknown as DevLayoutPreferencesV2['utility'],
    focusMode: value.focusMode,
    focusTargetId,
  }
}

/**
 * Migrates the #447 V1 envelope: fills all six panes from safe defaults,
 * keeps explicit full-width state per pane, demotes extra visible panes per
 * side, and normalizes focus to a center leaf.
 */
export function migrateLayoutPreferencesV1(value: DevLayoutPreferencesV1): DevLayoutPreferencesV2 {
  const leafIds = new Set(listLeaves(value.center).map((leaf) => leaf.id))
  const firstLeafId = listLeaves(value.center)[0]!.id
  const utility = utilities.map((pane, order): DevUtilityPreference => {
    const previous = value.utility.find((entry) => entry.pane === pane)
    if (!previous)
      return {
        pane,
        side: canonicalUtilitySides[pane],
        order,
        visible: false,
        size: defaultUtilitySize,
        lastNonzeroSize: defaultUtilitySize,
        fullWidth: false,
      }
    const fullWidth = previous.size > legacyFullWidthSize
    const size = fullWidth ? previous.lastNonzeroSize : previous.size
    return {
      pane,
      side: previous.side,
      order,
      visible: previous.visible,
      size: size > 0 ? size : defaultUtilitySize,
      lastNonzeroSize: previous.lastNonzeroSize > 0 ? previous.lastNonzeroSize : defaultUtilitySize,
      fullWidth,
    }
  })
  const visibleSeen = { left: false, right: false }
  const demoted = utility.map((entry) => {
    if (!entry.visible) return entry
    if (visibleSeen[entry.side]) return { ...entry, visible: false }
    visibleSeen[entry.side] = true
    return entry
  })
  return {
    schemaVersion: 2,
    scope: value.scope,
    projectId: value.projectId,
    runtimeSessionId: value.runtimeSessionId,
    center: value.center,
    utility: demoted as unknown as DevLayoutPreferencesV2['utility'],
    focusMode: value.focusMode,
    focusTargetId:
      value.focusTargetId !== undefined && leafIds.has(value.focusTargetId)
        ? value.focusTargetId
        : firstLeafId,
  }
}

/**
 * Decodes a stored layout document of any released version into the V2
 * envelope. V1 input is migrated; unknown versions and corrupt payloads are
 * retained verbatim in `raw` for recovery and are never deleted here.
 */
export function decodeLayoutDocument(raw: string): LayoutDocumentResult {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { state: 'corrupt', raw }
  }
  if (!isRecord(value)) return { state: 'corrupt', raw }
  if (value.schemaVersion === 2) {
    const decoded = decodePreferencesV2(value)
    return decoded ? { state: 'ready', value: decoded, migrated: false } : { state: 'corrupt', raw }
  }
  if (value.schemaVersion === 1) {
    if (!decodePreferences(value)) return { state: 'corrupt', raw }
    return { state: 'ready', value: migrateLayoutPreferencesV1(value), migrated: true }
  }
  return { state: 'unsupported', raw }
}

export function serializeLayoutPreferencesV2(value: DevLayoutPreferencesV2): string {
  const decoded = decodePreferencesV2(JSON.parse(JSON.stringify(value)) as unknown)
  if (!decoded) throw new TypeError('corrupt_state: invalid Dev layout preferences')
  return JSON.stringify(decoded)
}
