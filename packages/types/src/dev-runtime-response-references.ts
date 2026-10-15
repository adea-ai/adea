// Response-local citation contract (#1389). This module is browser-safe and
// owns validation only: it never retrieves a URL or infers sources from prose.
import {
  exactKeys,
  fail,
  integerValue,
  record,
  stringValue,
} from './dev-runtime-validation-internal'

export const RESPONSE_SOURCE_MAX = 32
export const RESPONSE_CITATION_MAX = 128
// Leaves room for the bounded event envelope in a 64 KiB runtime-events frame.
export const CITED_RESPONSE_BYTES_MAX = 48 * 1024

export type RuntimeResponseSource = Readonly<{
  id: string
  title: string
  url: string
  snippet?: string
}>

export type RuntimeCitationReference = Readonly<{
  sourceId: string
  /** Half-open UTF-16 offsets into this event's exact payload.text. */
  start: number
  end: number
}>

export type RuntimeResponseReferences = Readonly<{
  schemaVersion: 1
  sources: readonly RuntimeResponseSource[]
  citations: readonly RuntimeCitationReference[]
}>

/** Optional metadata on a final assistant message; never inferred from text. */
export type RuntimeAssistantResponsePayload = Readonly<{
  text: string
  references?: RuntimeResponseReferences
}>

const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/
const encoder = new TextEncoder()

function responseText(value: unknown, path: string, min: number, max: number): string {
  const text = stringValue(value, path, min, max)
  // JSON permits lone UTF-16 surrogates; the stream's UTF-8 encoder replaces
  // them. Refuse them so citation offsets always refer to replay-identical text.
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail(path, 'unpaired surrogate')
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) fail(path, 'unpaired surrogate')
  }
  return text
}

function identifier(value: unknown, path: string): string {
  const id = stringValue(value, path, 1, 128)
  if (!idPattern.test(id)) fail(path, 'expected bounded opaque source ID')
  return id
}

function sourceUrl(value: unknown, path: string): void {
  const raw = responseText(value, path, 1, 2048)
  // Reject parser-repaired URLs and hidden delimiters. Credentials (including
  // an empty userinfo section), local names, IP literals and alternate ports
  // are never source links. DNS names are not permission to fetch a resource.
  if (
    !/^https?:\/\//i.test(raw) ||
    /[\s\\\u202a-\u202e\u2066-\u2069]/u.test(raw) ||
    Array.from(raw).some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || (code >= 127 && code <= 159)
    }) ||
    /%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(raw)
  )
    fail(path, 'expected an absolute public HTTP(S) source URL')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    fail(path, 'invalid source URL')
  }
  const authority = raw.slice(raw.indexOf('://') + 3).split(/[/?#]/, 1)[0]!
  const hostname = url.hostname.toLowerCase()
  const labels = hostname.split('.')
  if (
    url.username ||
    url.password ||
    authority.includes('@') ||
    !authority ||
    authority.includes('%') ||
    url.port ||
    labels.length < 2 ||
    hostname.length > 253 ||
    labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    /^[0-9.]+$/.test(hostname) ||
    ['localhost', 'local', 'internal', 'lan', 'home', 'onion'].includes(labels.at(-1)!)
  )
    fail(path, 'source URL host, credentials or port are not allowed')
}

function splitsSurrogate(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1)
  const after = text.charCodeAt(offset)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
}

/** Validate an atomic source list and all its references against exact text. */
export function decodeRuntimeResponseReferences(
  value: unknown,
  text: string
): RuntimeResponseReferences {
  responseText(text, 'response.text', 0, 65_536)
  const path = 'response.references'
  const item = record(value, path)
  exactKeys(item, ['schemaVersion', 'sources', 'citations'], [], path)
  if (item.schemaVersion !== 1) fail(`${path}.schemaVersion`, 'expected 1')
  if (!Array.isArray(item.sources) || item.sources.length > RESPONSE_SOURCE_MAX)
    fail(`${path}.sources`, `expected at most ${RESPONSE_SOURCE_MAX} sources`)
  if (!Array.isArray(item.citations) || item.citations.length > RESPONSE_CITATION_MAX)
    fail(`${path}.citations`, `expected at most ${RESPONSE_CITATION_MAX} citations`)

  const ids = new Set<string>()
  for (const [index, entry] of item.sources.entries()) {
    const sourcePath = `${path}.sources[${index}]`
    const source = record(entry, sourcePath)
    exactKeys(source, ['id', 'title', 'url'], ['snippet'], sourcePath)
    const id = identifier(source.id, `${sourcePath}.id`)
    if (ids.has(id)) fail(`${sourcePath}.id`, 'duplicate source ID')
    ids.add(id)
    if (!responseText(source.title, `${sourcePath}.title`, 1, 512).trim())
      fail(`${sourcePath}.title`, 'expected nonblank title')
    sourceUrl(source.url, `${sourcePath}.url`)
    if ('snippet' in source) responseText(source.snippet, `${sourcePath}.snippet`, 0, 2048)
  }

  const seen = new Set<string>()
  for (const [index, entry] of item.citations.entries()) {
    const citationPath = `${path}.citations[${index}]`
    const citation = record(entry, citationPath)
    exactKeys(citation, ['sourceId', 'start', 'end'], [], citationPath)
    const id = identifier(citation.sourceId, `${citationPath}.sourceId`)
    if (!ids.has(id)) fail(`${citationPath}.sourceId`, 'source is not in this response')
    const start = integerValue(citation.start, `${citationPath}.start`, 0, text.length)
    const end = integerValue(citation.end, `${citationPath}.end`, start + 1, text.length)
    if (splitsSurrogate(text, start) || splitsSurrogate(text, end))
      fail(citationPath, 'citation splits a surrogate pair')
    const key = `${id}\u0000${start}\u0000${end}`
    if (seen.has(key)) fail(citationPath, 'duplicate citation')
    seen.add(key)
  }
  if (
    encoder.encode(JSON.stringify({ text, references: value })).byteLength >
    CITED_RESPONSE_BYTES_MAX
  )
    fail(path, 'maximum cited response encoded size exceeded')
  return value as RuntimeResponseReferences
}

/** Shared producer/wire/replay gate; legacy and unknown payloads stay opaque. */
export function validateRuntimeResponseReferences(
  kind: string,
  payload: unknown,
  source: string
): void {
  if (
    kind !== 'turn.assistant_message' ||
    payload === null ||
    typeof payload !== 'object' ||
    !Object.hasOwn(payload, 'references')
  )
    return
  const item = record(payload, 'response')
  exactKeys(item, ['text', 'references'], [], 'response')
  if (source === 'terminal_fallback')
    fail('response.references', 'terminal fallback cannot supply semantic sources')
  if (!['native', 'acp', 'authenticated_hook', 'host'].includes(source))
    fail('response.references', 'unsupported source provenance')
  decodeRuntimeResponseReferences(
    item.references,
    stringValue(item.text, 'response.text', 0, 65_536)
  )
}
