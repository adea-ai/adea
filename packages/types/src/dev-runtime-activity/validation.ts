import {
  exactKeys,
  fail,
  finiteNumber,
  integerValue,
  record,
  stringValue,
} from '../dev-runtime-validation-internal'

export const ACTIVITY_PAYLOAD_BYTES_MAX = 64 * 1024
export const ACTIVITY_JSON_NODES_MAX = 4096
export const ACTIVITY_JSON_DEPTH_MAX = 12
export const ACTIVITY_TEXT_MAX = 16 * 1024
const encoder = new TextEncoder()
function hasAddressControls(text: string): boolean {
  for (const character of text) {
    const code = character.charCodeAt(0)
    if (
      code <= 31 ||
      (code >= 127 && code <= 159) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    )
      return true
  }
  return false
}

/** Budget the actual JSON encoding incrementally, before constructing an encoded payload. */
export function assertActivityJsonBounds(value: unknown, path: string): void {
  let nodes = 0
  let bytes = 0
  const add = (size: number, location: string): void => {
    bytes += size
    if (bytes > ACTIVITY_PAYLOAD_BYTES_MAX) fail(location, 'maximum encoded activity size exceeded')
  }
  const text = (entry: string, location: string): void => {
    stringValue(entry, location, 0, ACTIVITY_TEXT_MAX)
    add(encoder.encode(JSON.stringify(entry)).byteLength, location)
  }
  const visit = (entry: unknown, location: string, depth: number): void => {
    if (++nodes > ACTIVITY_JSON_NODES_MAX) fail(location, 'maximum activity node count exceeded')
    if (depth > ACTIVITY_JSON_DEPTH_MAX) fail(location, 'maximum activity nesting exceeded')
    if (entry === null || typeof entry === 'boolean') {
      add(String(entry).length, location)
    } else if (typeof entry === 'string') {
      text(entry, location)
    } else if (typeof entry === 'number') {
      finiteNumber(entry, location)
      add(JSON.stringify(entry).length, location)
    } else if (Array.isArray(entry)) {
      if (entry.length > 256) fail(location, 'maximum activity array length exceeded')
      add(2 + Math.max(0, entry.length - 1), location)
      for (let index = 0; index < entry.length; index += 1) {
        if (!Object.hasOwn(entry, index)) fail(location, 'sparse arrays are not JSON')
        visit(entry[index], `${location}[${index}]`, depth + 1)
      }
    } else {
      const object = record(entry, location)
      const keys = Object.keys(object)
      if (keys.length > 256) fail(location, 'maximum activity object entries exceeded')
      add(2 + Math.max(0, keys.length - 1) + keys.length, location)
      for (const key of keys) {
        stringValue(key, `${location} key`, 1, 256)
        text(key, `${location} key`)
        visit(object[key], `${location}.${key}`, depth + 1)
      }
    }
  }
  visit(value, path, 0)
}

export function activityRecord(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = []
) {
  const item = record(value, path)
  exactKeys(item, required, optional, path)
  return item
}

export function activityVersion(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = []
) {
  const item = record(value, path)
  if (item.schemaVersion !== 1) fail(`${path}.schemaVersion`, 'expected 1')
  exactKeys(item, ['schemaVersion', ...required], optional, path)
  return item
}

export function activityId(value: unknown, path: string): string {
  const id = stringValue(value, path, 1, 256)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) fail(path, 'expected opaque activity identifier')
  return id
}

export function activityCount(value: unknown, path: string): number {
  return integerValue(value, path, 0)
}

export function activityArray(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(path, `expected array length 0..${max}`)
  return value
}

export function uniqueActivityId(seen: Set<string>, value: unknown, path: string): string {
  const id = activityId(value, path)
  if (seen.has(id)) fail(path, 'duplicate identity')
  seen.add(id)
  return id
}

/** Canonical portable worktree-relative data; never filesystem authority. */
export function activityPath(value: unknown, path: string, allowRoot = false): string {
  const text = stringValue(value, path, 1, 1024)
  if (allowRoot && text === '.') return text
  if (
    hasAddressControls(text) ||
    /[\\<>:"|?*]/.test(text) ||
    text.startsWith('~') ||
    /%(?:2e|2f|5c|25|0[0-9a-f]|1[0-9a-f]|7f)/i.test(text)
  )
    fail(path, 'expected safe worktree-relative path')
  const segments = text.split('/')
  if (
    segments.length > 64 ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment.length > 255 ||
        segment === '.' ||
        segment === '..' ||
        segment.toLowerCase() === '.git' ||
        /[. ]$/.test(segment) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
    )
  )
    fail(path, 'expected safe worktree-relative path')
  return text
}

/** An inert source address. No fetch, credential use or local-file access is authorized. */
export function activityUrl(value: unknown, path: string): string {
  const text = stringValue(value, path, 1, 2048)
  const authority = /^https:\/\/([^/?#]+)/i.exec(text)?.[1]
  if (!authority || authority.includes('@'))
    fail(path, 'expected absolute credential-free HTTPS URL')
  if (
    hasAddressControls(text) ||
    /\s|\\/.test(text) ||
    /%(?:0[0-9a-f]|1[0-9a-f]|7f|25)/i.test(text)
  )
    fail(path, 'expected safe HTTPS source URL')
  try {
    const decoded = decodeURIComponent(text)
    if (hasAddressControls(decoded) || decoded.includes('\\'))
      fail(path, 'expected safe HTTPS source URL')
  } catch {
    return fail(path, 'expected well-formed safe HTTPS source URL')
  }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return fail(path, 'expected safe HTTPS source URL')
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port === '0' ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/i.test(url.hostname) ||
    /(?:^|\.)(?:localhost|local|internal|lan|home)$/i.test(url.hostname)
  )
    fail(path, 'expected safe public HTTPS source URL')
  return text
}

export function optionalText(
  item: Record<string, unknown>,
  key: string,
  path: string,
  max: number
): void {
  if (item[key] !== undefined) stringValue(item[key], `${path}.${key}`, 1, max)
}

export function optionalCounts(
  item: Record<string, unknown>,
  keys: readonly string[],
  path: string
): void {
  for (const key of keys) if (item[key] !== undefined) activityCount(item[key], `${path}.${key}`)
}

export function optionalComplete(item: Record<string, unknown>, path: string): void {
  if (item.complete !== undefined && typeof item.complete !== 'boolean')
    fail(`${path}.complete`, 'expected boolean')
}
