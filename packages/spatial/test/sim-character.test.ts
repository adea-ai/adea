import { describe, expect, test } from 'bun:test'
import {
  MAX_SIM_MESSAGE_BYTES,
  MAX_SIM_SERIALIZED_CHARACTER_LENGTH,
  SIM_BRIDGE_CHANNEL,
  SIM_CHARACTER_SLOTS,
  createCharacterSaveClient,
  createOriginAllowlist,
  frameEnvelope,
  parseFrameMessage,
  parseHostMessage,
  parseSimCharacterValue,
  type SimFrameRequestMessage,
  type SimHostMessage,
} from '../src/sim-bridge'
import { isPlausibleCharacterId } from '../src'

const SIM = 'https://sim.adea.example'
const HOST = 'https://app.adea.example'
const BRIDGE = 'AbCdEfGhIjKlMnOpQrSt'
const frameWindow = { id: 'frame' }
const parentWindow = { id: 'parent' }
const hostContext = { origins: createOriginAllowlist([SIM]), frameWindow, bridgeId: BRIDGE }
const frameContext = { parentOrigin: HOST, parentWindow, bridgeId: BRIDGE }

/** The private serializer's default (157 characters), as audited. */
const DEFAULT_SERIALIZED =
  'character:v1:body-body-01|ears-ears-01|face-female-emotion-usual-01|hair-hairstyle-female-01|-|top-outfit-01|bottom-pants-01|shoes-shoe-sneakers-01|-|-|-|-|-'
/** The audited longest slot ids, 251 characters in total. */
const LONGEST_SERIALIZED = `character:v1:${[12, 12, 32, 24, 10, 14, 16, 22, 14, 18, 16, 23, 13]
  .map((length, index) => `${SIM_CHARACTER_SLOTS[index]}-`.padEnd(length, 'x'))
  .join('|')}`

const envelope = (type: string, payload: unknown) => ({
  channel: SIM_BRIDGE_CHANNEL,
  version: 1,
  bridgeId: BRIDGE,
  type,
  payload,
})
const fromFrame = (data: unknown) => ({ origin: SIM, source: frameWindow, data })
const fromHost = (data: unknown) => ({ origin: HOST, source: parentWindow, data })

const make = (next: string[]) => `character:v1:${next.join('|')}`

describe('character value grammar', () => {
  test('the audited default and longest values are accepted', () => {
    expect(DEFAULT_SERIALIZED).toHaveLength(157)
    expect(LONGEST_SERIALIZED).toHaveLength(251)
    expect(parseSimCharacterValue(DEFAULT_SERIALIZED)).toBe(DEFAULT_SERIALIZED)
    expect(parseSimCharacterValue(LONGEST_SERIALIZED)).toBe(LONGEST_SERIALIZED)
    expect(MAX_SIM_SERIALIZED_CHARACTER_LENGTH).toBeGreaterThan(251)
  })

  test('catalog ids keep their short rule', () => {
    for (const id of ['configurable', 'preset.researcher', 'a:b-c_d'])
      expect(parseSimCharacterValue(id)).toBe(id)
    for (const id of [
      '',
      'a'.repeat(65),
      'has space',
      'pipe|id',
      'character:v2:x',
      'character:',
      7,
      null,
    ])
      expect(parseSimCharacterValue(id)).toBeNull()
  })

  test('refuses malformed serialized values', () => {
    const slots = DEFAULT_SERIALIZED.slice('character:v1:'.length).split('|')
    const bad = [
      make(slots.slice(0, 12)),
      make([...slots, 'extra-01']),
      make(['-', ...slots.slice(1)]),
      make(['', ...slots.slice(1)]),
      make([' body-body-01', ...slots.slice(1)]),
      make(['body-body-01\n', ...slots.slice(1)]),
      make(['-body', ...slots.slice(1)]),
      make(['x'.repeat(49), ...slots.slice(1)]),
      make(['a/b', ...slots.slice(1)]),
      `${DEFAULT_SERIALIZED}|-`,
      DEFAULT_SERIALIZED.replace('character:v1:', 'character:v1: '),
      DEFAULT_SERIALIZED.replace('v1', 'v2'),
      `character:v1:${'x'.repeat(MAX_SIM_SERIALIZED_CHARACTER_LENGTH)}`,
    ]
    for (const value of bad) expect(parseSimCharacterValue(value)).toBeNull()
  })

  test('the shell check accepts the serialized default and still bounds everything else', () => {
    expect(isPlausibleCharacterId(DEFAULT_SERIALIZED)).toBe(true)
    expect(isPlausibleCharacterId('configurable')).toBe(true)
    expect(isPlausibleCharacterId('x'.repeat(128))).toBe(true)
    expect(isPlausibleCharacterId('x'.repeat(129))).toBe(false)
    expect(isPlausibleCharacterId(`${DEFAULT_SERIALIZED}|-`)).toBe(false)
    expect(isPlausibleCharacterId('character:v1:' + 'x'.repeat(200))).toBe(false)
    expect(isPlausibleCharacterId('')).toBe(false)
    expect(isPlausibleCharacterId(undefined)).toBe(false)
  })

  test('host.launch carries a serialized character and stays under the message budget', () => {
    const payload = {
      code: 'c'.repeat(43),
      expiresAt: '2026-10-17T12:00:00.000Z',
      surface: 'character-designer',
      character: LONGEST_SERIALIZED,
    }
    const result = parseHostMessage(fromHost(envelope('host.launch', payload)), frameContext)
    expect(result).toMatchObject({
      ok: true,
      message: { payload: { character: LONGEST_SERIALIZED } },
    })
    expect(JSON.stringify(envelope('host.launch', payload)).length).toBeLessThan(
      MAX_SIM_MESSAGE_BYTES
    )
    for (const character of [`${DEFAULT_SERIALIZED}|-`, 'character:v1:x'])
      expect(
        parseHostMessage(fromHost(envelope('host.launch', { ...payload, character })), frameContext)
      ).toEqual({ ok: false, reason: 'invalid_payload' })
  })
})

describe('frame requests', () => {
  test('frame.navigate names a designer and a bounded request id', () => {
    for (const target of ['room-designer', 'character-designer'])
      expect(
        parseFrameMessage(
          fromFrame(envelope('frame.navigate', { requestId: 'nav-1', target })),
          hostContext
        )
      ).toEqual({
        ok: true,
        message: { type: 'frame.navigate', payload: { requestId: 'nav-1', target } },
      })
    const bad: unknown[] = [
      { requestId: 'nav-1', target: 'hq' },
      { requestId: 'nav-1', target: 'https://evil.example' },
      { requestId: '', target: 'room-designer' },
      { requestId: 'x'.repeat(33), target: 'room-designer' },
      { requestId: 'a b', target: 'room-designer' },
      { target: 'room-designer' },
      { requestId: 'n', target: 'room-designer', url: 'https://evil.example' },
    ]
    for (const payload of bad)
      expect(
        parseFrameMessage(fromFrame(envelope('frame.navigate', payload)), hostContext)
      ).toEqual({
        ok: false,
        reason: 'invalid_payload',
      })
  })

  test('frame.character.save carries only a validated character', () => {
    const payload = { requestId: 's1', character: DEFAULT_SERIALIZED }
    const sent = frameEnvelope(BRIDGE, { type: 'frame.character.save', payload })
    expect(JSON.stringify(sent).length).toBeLessThan(MAX_SIM_MESSAGE_BYTES)
    expect(parseFrameMessage(fromFrame(sent), hostContext)).toEqual({
      ok: true,
      message: { type: 'frame.character.save', payload },
    })
    const bad: unknown[] = [
      { requestId: 's1', character: `${DEFAULT_SERIALIZED}|-` },
      { requestId: 's1', character: 'character:v1:body-body-01' },
      { requestId: 's1', character: 'bad id' },
      { requestId: 's1' },
      { character: 'configurable' },
      { requestId: 's1', character: 'configurable', url: '/x' },
    ]
    for (const body of bad)
      expect(
        parseFrameMessage(fromFrame(envelope('frame.character.save', body)), hostContext)
      ).toEqual({
        ok: false,
        reason: 'invalid_payload',
      })
  })

  test('host.character.save.result is closed: success has no reason, failure names one', () => {
    const ok = [
      { requestId: 's1', saved: true },
      { requestId: 's1', saved: false, reason: 'refused' },
      { requestId: 's1', saved: false, reason: 'failed' },
      { requestId: 's1', saved: false, reason: 'timeout' },
    ]
    for (const body of ok)
      expect(
        parseHostMessage(fromHost(envelope('host.character.save.result', body)), frameContext)
      ).toEqual({
        ok: true,
        message: { type: 'host.character.save.result', payload: body },
      })
    const bad: unknown[] = [
      { requestId: 's1', saved: true, reason: 'refused' },
      { requestId: 's1', saved: false },
      { requestId: 's1', saved: false, reason: 'because' },
      { requestId: 's1', saved: 'yes' },
      { saved: true },
      { requestId: 's1', saved: true, token: 'x' },
    ]
    for (const body of bad)
      expect(
        parseHostMessage(fromHost(envelope('host.character.save.result', body)), frameContext)
      ).toEqual({
        ok: false,
        reason: 'invalid_payload',
      })
  })
})

function client(options: { timeoutMs?: number } = {}) {
  const posted: SimFrameRequestMessage[] = []
  const timers: { run: () => void; cancelled: boolean }[] = []
  const instance = createCharacterSaveClient({
    post: (message) => posted.push(message),
    timeoutMs: options.timeoutMs,
    schedule: (run) => {
      const timer = { run, cancelled: false }
      timers.push(timer)
      return () => (timer.cancelled = true)
    },
  })
  return { instance, posted, timers }
}

const answer = (requestId: string, saved: boolean, reason?: 'refused'): SimHostMessage => ({
  type: 'host.character.save.result',
  payload: saved
    ? { requestId, saved: true }
    : { requestId, saved: false, reason: reason ?? 'refused' },
})

describe('character save client', () => {
  test('resolves true only for the matching acknowledged request', async () => {
    const { instance, posted, timers } = client()
    const saved = instance.save(DEFAULT_SERIALIZED)
    expect(posted).toEqual([
      {
        type: 'frame.character.save',
        payload: { requestId: 'save1', character: DEFAULT_SERIALIZED },
      },
    ])
    instance.receive(answer('other', true))
    instance.receive(answer('save1', true))
    expect(await saved).toBe(true)
    expect(timers[0]!.cancelled).toBe(true)
  })

  test('refusal, timeout, host dispose and client dispose never resolve true', async () => {
    const refused = client()
    const a = refused.instance.save('configurable')
    refused.instance.receive(answer('save1', false))
    expect(await a).toBe(false)

    const timed = client()
    const b = timed.instance.save('configurable')
    timed.timers[0]!.run()
    expect(await b).toBe(false)
    timed.instance.receive(answer('save1', true))

    const disposedByHost = client()
    const c = disposedByHost.instance.save('configurable')
    disposedByHost.instance.receive({ type: 'host.dispose', payload: {} })
    expect(await c).toBe(false)

    const disposed = client()
    const d = disposed.instance.save('configurable')
    disposed.instance.dispose()
    expect(await d).toBe(false)
    expect(await disposed.instance.save('configurable')).toBe(false)
    expect(disposed.posted).toHaveLength(1)
  })

  test('a late answer for a timed-out request cannot satisfy the next save', async () => {
    const { instance, timers } = client()
    const first = instance.save('configurable')
    timers[0]!.run()
    expect(await first).toBe(false)
    const second = instance.save('configurable')
    instance.receive(answer('save1', true))
    instance.receive(answer('save2', true))
    expect(await second).toBe(true)
  })

  test('one save at a time, invalid values and a throwing post fail without posting', async () => {
    const { instance, posted } = client()
    const first = instance.save('configurable')
    expect(await instance.save('configurable')).toBe(false)
    expect(await instance.save(`${DEFAULT_SERIALIZED}|-`)).toBe(false)
    expect(posted).toHaveLength(1)
    instance.receive(answer('save1', true))
    expect(await first).toBe(true)

    const throwing = createCharacterSaveClient({
      post: () => {
        throw new Error('detached')
      },
    })
    expect(await throwing.save('configurable')).toBe(false)
  })
})
