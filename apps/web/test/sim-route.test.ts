import { expect, test } from 'bun:test'
import { commitSimCharacter, navigateSimDesigner } from '../src/lib/sim-route'

function fixture() {
  let href = 'https://app.example/?view=virtual&characterDesigner=1&other=retained#settings/account'
  let notifications = 0
  const state = { router: 'retained' }
  const win = {
    location: {
      get href() {
        return href
      },
    },
    history: {
      state,
      replaceState(next: unknown, _: string, url: URL) {
        expect(next).toBe(state)
        href = url.toString()
      },
    },
    dispatchEvent() {
      notifications++
      return true
    },
  } as unknown as Window
  const abort = new AbortController()
  const request = {
    signal: abort.signal,
    workspaceId: 'one',
    surface: 'character-designer',
    bridgeId: 'nonce-one',
    attempt: 1,
  }
  const current = { workspaceId: 'one', surface: 'character-designer', bridgeId: 'nonce-one' }
  return { win, request, current, abort, href: () => href, notifications: () => notifications }
}

test('save commits the parent selection before acknowledging, preserving other route state', () => {
  const f = fixture()
  expect(commitSimCharacter(f.win, 'avatar-id', f.request, f.current)).toBe(true)
  const url = new URL(f.href())
  expect(url.searchParams.get('character')).toBe('avatar-id')
  expect(url.searchParams.get('other')).toBe('retained')
  expect(url.hash).toBe('#settings/account')
  expect(f.notifications()).toBe(1)
})

test('cancelled, superseded and malformed saves cannot overwrite the parent route', () => {
  const f = fixture()
  const before = f.href()
  for (const patch of [
    { workspaceId: 'two' },
    { surface: 'hq' },
    { bridgeId: 'old' },
    { attempt: 0 },
    { attempt: NaN },
  ])
    expect(commitSimCharacter(f.win, 'avatar-id', { ...f.request, ...patch }, f.current)).toBe(
      false
    )
  expect(commitSimCharacter(f.win, 'invalid value', f.request, f.current)).toBe(false)
  f.abort.abort()
  expect(commitSimCharacter(f.win, 'avatar-id', f.request, f.current)).toBe(false)
  expect(f.href()).toBe(before)
  expect(f.notifications()).toBe(0)
})

test('HQ navigation chooses one designer on the parent route and retains the character', () => {
  const f = fixture()
  commitSimCharacter(f.win, 'avatar-id', f.request, f.current)
  navigateSimDesigner(f.win, 'room-designer')
  let url = new URL(f.href())
  expect(url.searchParams.get('roomDesigner')).toBe('1')
  expect(url.searchParams.has('characterDesigner')).toBe(false)
  navigateSimDesigner(f.win, 'character-designer')
  url = new URL(f.href())
  expect(url.searchParams.get('characterDesigner')).toBe('1')
  expect(url.searchParams.has('roomDesigner')).toBe(false)
  expect(url.searchParams.get('character')).toBe('avatar-id')
})
