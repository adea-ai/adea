/*
 * Editor document model (#399): byte-faithful round-tripping for the text
 * the editor touches. The provider preserves BOM, per-line mixed EOL, and the
 * final newline on disk; the editor keeps an exact EOL ledger so a save can
 * reproduce the file it loaded instead of normalizing to a majority style.
 * Also derives the compare-and-swap identity facts a save must pin.
 */
import type { FileReadResult } from '@adea-ai/types/dev-runtime'

export type LineEnding = 'lf' | 'crlf'

export type EditorDocument = Readonly<{
  /** BOM-prefixed, line-ending-normalized text handed to CodeMirror. */
  text: string
  /** Per-break ledger: eols[i] is the ending that followed line i. */
  eols: readonly LineEnding[]
  /** Whether the file's final byte was a newline. */
  endsWithNewline: boolean
  hadBom: boolean
}>

/** Decode a UTF-8 read result into an editor document. Binary reads are
 *  refused (the pane shows read-only metadata instead). */
export function documentFromRead(read: FileReadResult): EditorDocument {
  const bytes = read.bytes
  const hadBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  const body = hadBom ? bytes.slice(3) : bytes
  let text = new TextDecoder('utf-8', { fatal: false }).decode(body)
  const eols: LineEnding[] = []
  let endsWithNewline = false
  // Split on CRLF first, then bare LF, recording which ending each break used.
  const segments = text.split('\n')
  endsWithNewline = segments.length > 1 && segments[segments.length - 1] === ''
  if (endsWithNewline) segments.pop()
  for (const [index, segment] of segments.entries()) {
    const isLast = index === segments.length - 1
    if (segment.endsWith('\r')) {
      eols.push('crlf')
      // The \r belongs to the break, not the line content.
      segments[index] = segment.slice(0, -1)
    } else if (!isLast) {
      eols.push('lf')
    } else if (endsWithNewline) {
      // The trailing empty segment was popped; the (now) last line still had
      // a break before the end of file.
      eols.push('lf')
    }
    // A final line without a trailing break records no ending, so the join
    // can reproduce the exact bytes.
  }
  text = segments.join('\n')
  return {
    text,
    eols,
    endsWithNewline,
    hadBom,
  }
}

/** Serialize an edited document back to bytes: line content from the editor,
 *  endings and the final newline from the ledger, BOM reattached. */
export function documentToBytes(
  document: EditorDocument,
  editedText: string,
  eolPolicy: 'preserve' | 'lf' | 'crlf'
): Uint8Array {
  const lines = editedText.length === 0 ? [''] : editedText.split('\n')
  const body =
    eolPolicy === 'preserve'
      ? joinWithLedger(lines, document.eols, document.endsWithNewline)
      : eolPolicy === 'lf'
        ? `${lines.join('\n')}${document.endsWithNewline ? '\n' : ''}`
        : `${lines.join('\r\n')}${document.endsWithNewline ? '\r\n' : ''}`
  const prefix = document.hadBom ? '\uFEFF' : ''
  return new TextEncoder().encode(`${prefix}${body}`)
}

function joinWithLedger(
  lines: readonly string[],
  eols: readonly LineEnding[],
  endsWithNewline: boolean
): string {
  let out = ''
  for (const [index, line] of lines.entries()) {
    const isLastLineOfText = index === lines.length - 1
    const ending: LineEnding | undefined = eols[index] ?? (endsWithNewline ? 'lf' : undefined)
    if (isLastLineOfText && !endsWithNewline && ending === undefined) {
      out += line
      break
    }
    out += `${line}${ending === 'crlf' ? '\r\n' : '\n'}`
  }
  return out
}

/** Whether the read window is the whole file and text-safe for editing. */
export function editingReadiness(read: FileReadResult): {
  editable: boolean
  reason?: string
} {
  if (read.encoding === 'binary') {
    return { editable: false, reason: 'binary or non-UTF-8 content opens read-only' }
  }
  if (!read.eof) {
    return {
      editable: false,
      reason: 'file is larger than the control-path read window; preview is read-only',
    }
  }
  return { editable: true }
}

/** The digest a bulk write grant declares (#399 residue): hex-encoded
 *  SHA-256 over the exact bytes about to be streamed. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const view = new Uint8Array(bytes.byteLength)
  view.set(bytes)
  const digest = await crypto.subtle.digest('SHA-256', view)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Builds the same read shape the control path returns, from bytes the
 *  bulk stream delivered (#399 residue): the whole file (eof), with the
 *  provider's eol/encoding analysis mirrored client-side. */
export function readResultFromBytes(
  bytes: Uint8Array,
  header: { entry: FileReadResult['entry']; offset?: string }
): FileReadResult {
  const hadBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  const body = hadBom ? bytes.slice(3) : bytes
  let encoding: 'utf8' | 'binary' = 'utf8'
  for (const byte of body) {
    if (byte === 0) {
      encoding = 'binary'
      break
    }
  }
  if (encoding === 'utf8') {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(body)
    } catch {
      encoding = 'binary'
    }
  }
  let lf = 0
  let crlf = 0
  for (const [index, byte] of bytes.entries()) {
    if (byte !== 0x0a) continue
    if (index > 0 && bytes[index - 1] === 0x0d) crlf += 1
    else lf += 1
  }
  const eol = lf + crlf === 0 ? 'none' : lf > 0 && crlf > 0 ? 'mixed' : crlf > 0 ? 'crlf' : 'lf'
  return {
    entry: header.entry,
    offset: header.offset ?? '0',
    bytes,
    eof: true,
    eol,
    encoding,
  }
}
