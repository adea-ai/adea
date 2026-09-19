// Issue #396: TerminalInputAuthority admits one source per generation, is
// re-checked before every chunk, and fails closed on ownership changes,
// stale generations, and cross-terminal fences.
import { describe, expect, test } from 'bun:test'

import {
  createInputAuthority,
  fencedWrite,
  type InputFence,
} from '../shell/src/dev-runtime/terminal/input-authority'

const terminalId = '00000000-0000-4000-8000-0000000000b2'

describe('terminal input authority', () => {
  test('admits one source per generation and replaces it atomically', () => {
    const authority = createInputAuthority(terminalId)
    const user = authority.admit('terminal_user', 1)
    expect(user.ok).toBe(true)
    expect(authority.snapshot().owner).toEqual({ source: 'terminal_user', generation: 1 })
    const chat = authority.admit('chat_user', 1)
    expect(chat.ok).toBe(true)
    expect(authority.snapshot().owner).toEqual({ source: 'chat_user', generation: 1 })
    // The old fence lost its epoch with the ownership change.
    if (user.ok) {
      expect(authority.admitChunk(user.fence).ok).toBe(false)
    }
  })

  test('a second writer cannot retain the previous fence for the same generation', () => {
    const authority = createInputAuthority(terminalId)
    const first = authority.admit('terminal_user', 1)
    const second = authority.admit('terminal_user', 1)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (first.ok) expect(authority.admitChunk(first.fence).ok).toBe(false)
    if (second.ok) expect(authority.admitChunk(second.fence).ok).toBe(true)
  })

  test('rejects admissions behind the active generation', () => {
    const authority = createInputAuthority(terminalId)
    authority.admit('terminal_user', 3)
    const stale = authority.admit('prompt_delivery', 2)
    expect(stale.ok).toBe(false)
    if (!stale.ok) {
      expect(stale.code).toBe('stale_generation')
      expect(stale.message).toContain('3')
    }
    // Same generation from a new source is an explicit, allowed transfer.
    expect(authority.admit('prompt_delivery', 3).ok).toBe(true)
    // A later generation is an ownership epoch, not an error.
    expect(authority.admit('browser_takeover', 4).ok).toBe(true)
  })

  test('a partial paste cannot cross an ownership change', () => {
    const authority = createInputAuthority(terminalId)
    const admitted = authority.admit('terminal_user', 1)
    expect(admitted.ok).toBe(true)
    const fence = (admitted as { ok: true; fence: InputFence }).fence
    const written: Uint8Array[] = []
    const chunks = [1, 2, 3, 4, 5].map((n) => new Uint8Array([n]))
    // Ownership transfers to the harness prompt-delivery path mid-paste.
    authority.admit('prompt_delivery', 1)
    const result = fencedWrite(authority, fence, chunks, (chunk) => written.push(chunk))
    expect(result.written).toBe(0)
    expect(result.stopped).toBe(true)
    expect(written).toEqual([])
  })

  test('fencedWrite revalidates before every chunk and stops at the exact boundary', () => {
    const authority = createInputAuthority(terminalId)
    const admitted = authority.admit('terminal_user', 1)
    const fence = (admitted as { ok: true; fence: InputFence }).fence
    const written: number[] = []
    const chunks = [1, 2, 3, 4].map((n) => new Uint8Array([n]))
    let writes = 0
    const result = fencedWrite(authority, fence, chunks, (chunk) => {
      writes += 1
      written.push(chunk[0]!)
      // Simulate an ownership change observed between chunk 3 and 4.
      if (writes === 3) authority.admit('browser_takeover', 1)
    })
    expect(result.written).toBe(3)
    expect(result.stopped).toBe(true)
    expect(written).toEqual([1, 2, 3])
  })

  test('release only works for the current owner and clears ownership', () => {
    const authority = createInputAuthority(terminalId)
    authority.admit('terminal_user', 1)
    expect(authority.release('chat_user', 1).ok).toBe(false)
    expect(authority.release('terminal_user', 2).ok).toBe(false)
    expect(authority.release('terminal_user', 1).ok).toBe(true)
    expect(authority.snapshot().owner).toBeNull()
    expect(authority.release('terminal_user', 1).ok).toBe(true)
  })

  test('fences are terminal-bound and epoch-bound', () => {
    const authority = createInputAuthority(terminalId)
    const admitted = authority.admit('terminal_user', 1)
    const fence = (admitted as { ok: true; fence: InputFence }).fence
    const foreign = createInputAuthority('00000000-0000-4000-8000-0000000000c3')
    expect(foreign.admitChunk(fence).ok).toBe(false)
    authority.release('terminal_user', 1)
    expect(authority.admitChunk(fence).ok).toBe(false)
  })
})
