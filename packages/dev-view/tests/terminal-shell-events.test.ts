// Issue #396 shell-event parsing and typed integration availability: OSC 7
// cwd hints and standard OSC 133 markers parsed from the pane stream (never
// trusted for command blocks), and the integration tracker that says
// truthfully which features are live.
import { describe, expect, test } from 'bun:test'

import {
  createIntegrationState,
  integrationActive,
  integrationAnnouncement,
  integrationPresentation,
  reduceIntegration,
} from '../src/terminal/integration'
import { parseOsc133Marker, parseOsc7Cwd } from '../src/terminal/shell-events'

describe('OSC 7 cwd parsing', () => {
  test('parses file URLs with and without a host, percent-decoded', () => {
    expect(parseOsc7Cwd('file://myhost/Users/am/repo')).toEqual({
      cwd: '/Users/am/repo',
      host: 'myhost',
    })
    expect(parseOsc7Cwd('file:///Users/am/my%20repo')).toEqual({ cwd: '/Users/am/my repo' })
  })

  test('parses a bare absolute path', () => {
    expect(parseOsc7Cwd('/Users/am/repo')).toEqual({ cwd: '/Users/am/repo' })
  })

  test('rejects hostile and unusable payloads', () => {
    expect(parseOsc7Cwd('')).toBeNull()
    expect(parseOsc7Cwd('ftp://host/path')).toBeNull()
    expect(parseOsc7Cwd('https://host/path')).toBeNull()
    expect(parseOsc7Cwd('relative/path')).toBeNull()
    expect(parseOsc7Cwd('file://host/no-scheme-tail')).not.toBeNull()
    expect(parseOsc7Cwd('file://%00/etc')).toBeNull() // decoded control character
    expect(parseOsc7Cwd(`/${'a'.repeat(2000)}`)).toBeNull() // oversize
    expect(parseOsc7Cwd('file://host/%zz')).toBeNull() // malformed encoding
  })
})

describe('OSC 133 marker parsing', () => {
  test('parses the standard prompt/command/output markers', () => {
    expect(parseOsc133Marker('A')).toEqual({ kind: 'prompt-start' })
    expect(parseOsc133Marker('B')).toEqual({ kind: 'command-start' })
    expect(parseOsc133Marker('C')).toEqual({ kind: 'output-start' })
    expect(parseOsc133Marker('D')).toEqual({ kind: 'output-end' })
  })

  test('parses exit codes on the final marker and rejects malformed payloads', () => {
    expect(parseOsc133Marker('D;0')).toEqual({ kind: 'output-end', exitCode: 0 })
    expect(parseOsc133Marker('D;130')).toEqual({ kind: 'output-end', exitCode: 130 })
    expect(parseOsc133Marker('D;not-a-code')).toBeNull()
    expect(parseOsc133Marker('X')).toBeNull()
    expect(parseOsc133Marker('')).toBeNull()
    expect(parseOsc133Marker('A;extra')).toBeNull()
  })
})

describe('integration availability', () => {
  test('an authenticated observation activates blocks and exit codes', () => {
    let state = createIntegrationState(['markers', 'cwd', 'history'])
    expect(integrationPresentation(state).status).toBe('pending')
    state = reduceIntegration(state, { type: 'observation' })
    expect(integrationActive(state)).toBe(true)
    const presentation = integrationPresentation(state)
    expect(presentation.status).toBe('active')
    expect(presentation.detail).toContain('authenticated')
  })

  test('no wrapper and no traffic degrades typed, never silently', () => {
    const state = createIntegrationState()
    const presentation = integrationPresentation(state)
    expect(presentation.status).toBe('unavailable')
    expect(presentation.detail).toContain('without')
  })

  test('unauthenticated stream markers are reported but never activate blocks', () => {
    let state = createIntegrationState()
    state = reduceIntegration(state, { type: 'stream-marker' })
    state = reduceIntegration(state, { type: 'stream-cwd' })
    expect(integrationActive(state)).toBe(false)
    const presentation = integrationPresentation(state)
    expect(presentation.status).toBe('unavailable')
    expect(presentation.detail).toContain('unauthenticated')
  })

  test('host-declared features hold the pending state until traffic arrives', () => {
    const state = createIntegrationState(['markers'])
    expect(integrationPresentation(state).status).toBe('pending')
  })

  test('announcements fire only on status transitions', () => {
    const unavailable = integrationPresentation(createIntegrationState())
    let state = createIntegrationState(['markers'])
    const pending = integrationPresentation(state)
    expect(integrationAnnouncement(unavailable, pending)).toBeUndefined()
    state = reduceIntegration(state, { type: 'observation' })
    const active = integrationPresentation(state)
    expect(integrationAnnouncement(pending, active)).toBe('Shell integration active')
    expect(integrationAnnouncement(active, active)).toBeUndefined()
  })
})
