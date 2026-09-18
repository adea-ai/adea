// Issue #396 renderer policy and editor reducer: WebGL→DOM fallback ladder
// (init failure, bounded context-loss recovery) and the bottom editor's
// multiline/control paste confirmation, history navigation, deduplicated
// history commits, and raw-mode escape hatch.
import { describe, expect, test } from 'bun:test'

import { applyObservation, blockExportText, createBlocksState } from '../src/terminal/blocks'
import {
  createEditorState,
  editorChangeDraft,
  editorConfirmPaste,
  editorHistoryStep,
  editorRejectPaste,
  editorSend,
  editorStagePaste,
  editorToggleMode,
  pasteNeedsConfirmation,
} from '../src/terminal/editor'
import { createRendererPolicy } from '../src/terminal/renderer-policy'

describe('renderer policy', () => {
  test('prefers lazy WebGL and falls back to DOM on init failure', () => {
    const policy = createRendererPolicy()
    expect(policy.snapshot().active).toBe('dom')
    expect(policy.mounted().active).toBe('webgl')
    const result = policy.webglInitFailed('no canvas')
    expect(result.active).toBe('dom')
    expect(result.webglDisabled).toBe(true)
    // Once disabled, remounts stay on DOM.
    expect(policy.mounted().active).toBe('dom')
  })

  test('context loss recovers within the budget then stays on DOM', () => {
    const policy = createRendererPolicy(2)
    policy.mounted()
    const first = policy.contextLost()
    expect(first.retryWebgl).toBe(true)
    expect(policy.webglRestored().active).toBe('webgl')
    const second = policy.contextLost()
    expect(second.retryWebgl).toBe(true)
    policy.webglRestored()
    const third = policy.contextLost()
    expect(third.retryWebgl).toBe(false)
    expect(third.policy.active).toBe('dom')
    expect(third.policy.webglDisabled).toBe(true)
  })
})

describe('command blocks', () => {
  test('authenticated observations open, complete, and annotate blocks', () => {
    let state = createBlocksState()
    state = applyObservation(state, {
      kind: 'preexec',
      command: 'bun test',
      at: '2026-09-18T00:00:00.000Z',
      sequence: '4',
    })
    expect(state.blocks).toHaveLength(1)
    expect(state.blocks[0]).toMatchObject({
      command: 'bun test',
      state: 'running',
      startSequence: '4',
    })
    state = applyObservation(state, {
      kind: 'precmd',
      exitCode: 0,
      at: '2026-09-18T00:00:02.500Z',
      sequence: '9',
    })
    expect(state.blocks[0]).toMatchObject({ state: 'completed', exitCode: 0, durationMs: 2500 })
    state = applyObservation(state, { kind: 'cwd', cwd: '/repo', at: '2026-09-18T00:00:03.000Z' })
    expect(state.cwd).toBe('/repo')
  })

  test('an unmatched precmd never fabricates a block', () => {
    const state = createBlocksState()
    const next = applyObservation(state, {
      kind: 'precmd',
      exitCode: 0,
      at: '2026-09-18T00:00:00.000Z',
      sequence: '0',
    })
    expect(next.blocks).toHaveLength(0)
    expect(next).toBe(state)
  })

  test('completed blocks can be exported locally; running blocks cannot', () => {
    let state = createBlocksState()
    state = applyObservation(state, {
      kind: 'preexec',
      command: 'ls',
      at: '2026-09-18T00:00:00.000Z',
      sequence: '0',
    })
    expect(blockExportText(state.blocks[0]!)).toBeNull()
    state = applyObservation(state, {
      kind: 'precmd',
      exitCode: 3,
      at: '2026-09-18T00:00:01.000Z',
      sequence: '2',
    })
    expect(blockExportText(state.blocks[0]!)).toContain('exit 3')
  })

  test('block history is bounded', () => {
    let state = createBlocksState(3)
    for (let index = 0; index < 6; index += 1) {
      state = applyObservation(state, {
        kind: 'preexec',
        command: `cmd-${index}`,
        at: '2026-09-18T00:00:00.000Z',
        sequence: String(index),
      })
    }
    expect(state.blocks).toHaveLength(3)
    expect(state.blocks.map((block) => JSON.parse(JSON.stringify(block.command)))).toEqual([
      'cmd-3',
      'cmd-4',
      'cmd-5',
    ])
  })
})

describe('bottom editor', () => {
  test('multiline and control-character pastes require confirmation', () => {
    expect(pasteNeedsConfirmation('plain text')).toBe(false)
    expect(pasteNeedsConfirmation('two\nlines')).toBe(true)
    expect(pasteNeedsConfirmation('bell\x07text')).toBe(true)
    const state = createEditorState()
    const staged = editorStagePaste(state, 'a\nb')
    expect(staged.pendingPaste).toBe('a\nb')
    expect(staged.draft).toBe('')
    const confirmed = editorConfirmPaste(staged)
    expect(confirmed.draft).toBe('a\nb')
    expect(confirmed.pendingPaste).toBeUndefined()
    // Rejection leaves the draft untouched.
    const rejected = editorRejectPaste(staged)
    expect(rejected.draft).toBe('')
    expect(rejected.pendingPaste).toBeUndefined()
  })

  test('history navigation stashes the in-progress draft and restores it', () => {
    let state = createEditorState(['latest', 'older'])
    state = editorChangeDraft(state, 'in progress')
    state = editorHistoryStep(state, 'up')
    expect(state.draft).toBe('latest')
    state = editorHistoryStep(state, 'up')
    expect(state.draft).toBe('older')
    expect(state.historyIndex).toBe(1)
    state = editorHistoryStep(state, 'down')
    expect(state.draft).toBe('latest')
    state = editorHistoryStep(state, 'down')
    expect(state.draft).toBe('in progress')
    expect(state.historyIndex).toBeNull()
    // Clamped at both ends.
    state = editorHistoryStep(state, 'down')
    expect(state.draft).toBe('in progress')
  })

  test('send commits a deduplicated bounded history entry and clears the draft', () => {
    let state = createEditorState(['bun test'])
    state = editorChangeDraft(state, 'bun lint')
    const sent = editorSend(state)!
    expect(sent.payload).toBe('bun lint')
    expect(sent.state.draft).toBe('')
    expect(sent.state.history).toEqual(['bun lint', 'bun test'])
    // Sending the same command moves it to the front instead of duplicating.
    const again = editorChangeDraft(sent.state, 'bun lint')
    const sentAgain = editorSend(again)!
    expect(sentAgain.state.history).toEqual(['bun lint', 'bun test'])
    // An empty draft never sends.
    expect(editorSend(createEditorState())).toBeNull()
  })

  test('raw mode bypasses compose affordances for full-screen TUIs', () => {
    let state = createEditorState()
    state = editorStagePaste(state, 'multi\nline')
    const raw = editorToggleMode(state)
    expect(raw.mode).toBe('raw')
    expect(raw.pendingPaste).toBeUndefined()
    const compose = editorToggleMode(raw)
    expect(compose.mode).toBe('compose')
  })
})
