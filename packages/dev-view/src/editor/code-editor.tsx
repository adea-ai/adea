/*
 * Central editor leaf (#399): a framework-thin CodeMirror surface reached
 * through a dynamic import (the lazy boundary), windowed reads through the
 * gate, EOL/BOM/final-newline-preserving saves with compare-and-swap
 * identity, and deterministic save-conflict handling — Reload (discard local
 * edits) or explicit Overwrite, never a silent clobber.
 */
import type { FileEntry, FileIdentity } from '@adea-ai/types/dev-runtime'
import { cn } from '@adea-ai/app-ui/lib/utils'
import { RefreshCw, Save } from 'lucide-solid'
import { Show, onCleanup, onMount, createSignal, type JSX } from 'solid-js'

import { executeOperation, type WorktreeContext } from '../files/worktree-context'
import type { DevRuntimeService } from '../platform'
import {
  documentFromRead,
  documentToBytes,
  editingReadiness,
  readResultFromBytes,
  sha256Hex,
  type EditorDocument,
} from './editor-document'
import '../files/files-pane.css'

export type CodeEditorProps = Readonly<{
  runtime: DevRuntimeService
  worktree: WorktreeContext
  relativePath: string
  /** The identity the file had when it was opened (the first CAS pin). */
  identity: FileIdentity
  onClose(): void
}>

type MirrorHandle = {
  getText(): string
  setEditable(editable: boolean): void
  destroy(): void
}

type FileReadReply = {
  entry: FileEntry
  offset: string
  bytes: Uint8Array
  eof: boolean
  eol: 'lf' | 'crlf' | 'mixed' | 'none'
  encoding: 'utf8' | 'binary'
}

// Inline control-path content is capped at 256 KiB (the control payload
// limit); larger files open and save through the file-bytes-v1 bulk stream
// when the host exposes a stream transport, and stay bounded read-only
// previews otherwise (#399 residue).
const CONTROL_INLINE_MAX = 256 * 1024
const FILE_STREAM_MAX = 64 * 1024 * 1024

/** The host stream transport, when this runtime can attach minted grants. */
function streamTransportOf(runtime: DevRuntimeService) {
  return runtime.streams?.() ?? undefined
}

export function CodeEditor(props: CodeEditorProps): JSX.Element {
  const [mirror, setMirror] = createSignal<MirrorHandle | undefined>()
  const [document, setDocument] = createSignal<EditorDocument | undefined>()
  const [pinnedIdentity, setPinnedIdentity] = createSignal<FileIdentity>(props.identity)
  const [dirty, setDirty] = createSignal(false)
  const [readOnlyReason, setReadOnlyReason] = createSignal<string | undefined>()
  const [conflict, setConflict] = createSignal(false)
  const [notice, setNotice] = createSignal<string | undefined>()
  const [status, setStatus] = createSignal<'loading' | 'ready' | 'failed'>('loading')
  const [previewText, setPreviewText] = createSignal<string | undefined>()

  onMount(() => {
    void load()
  })

  onCleanup(() => {
    mirror()?.destroy()
  })

  async function readWindow(): Promise<FileReadReply> {
    return executeOperation<FileReadReply>(
      props.runtime,
      scopeOf(),
      'dev.files.read',
      {
        worktreeId: props.worktree.worktreeId,
        path: {
          worktreeId: props.worktree.worktreeId,
          rootIdentity: props.worktree.rootIdentity,
          relativePath: props.relativePath,
        },
      },
      {
        kind: 'workspace_root',
        id: props.worktree.worktreeId,
        generation: props.worktree.generation,
      }
    )
  }

  function scopeOf() {
    const scope = props.runtime.preferenceScope?.()
    if (!scope) throw { error: { code: 'unauthenticated', message: 'runtime scope missing' } }
    return scope
  }

  async function load(): Promise<void> {
    try {
      setStatus('loading')
      const streamSized = Number(props.identity.size) > CONTROL_INLINE_MAX
      const read =
        streamSized && Number(props.identity.size) <= FILE_STREAM_MAX
          ? await streamOpen()
          : await readWindow()
      setPinnedIdentity(read.entry.identity)
      const readiness = editingReadiness(read)
      if (!readiness.editable) {
        setReadOnlyReason(readiness.reason)
        setPreviewText(new TextDecoder('utf-8', { fatal: false }).decode(read.bytes))
        setStatus('ready')
        return
      }
      const parsed = documentFromRead(read)
      setDocument(parsed)
      setReadOnlyReason(undefined)
      const { createMirror } = await import('./editor-mirror')
      setStatus('ready')
      const container = surfaceElement
      if (!container) return
      container.innerHTML = ''
      const handle = createMirror({
        parent: container,
        initialText: parsed.text,
        editable: true,
        onDocChanged: (edited) => setDirty(edited),
        onSave: () => void save(),
      })
      setMirror(handle)
    } catch (reply) {
      setNotice(describeError(reply))
      setStatus('failed')
    }
  }

  /** Bulk open: mint a file-bytes-v1 read grant, pump the bytes through the
   *  lazy stream model, and feed them through the same document pipeline. */
  async function streamOpen(): Promise<FileReadReply> {
    const scope = props.runtime.preferenceScope?.()
    if (!scope) throw { error: { code: 'unauthenticated', message: 'runtime scope missing' } }
    const transport = streamTransportOf(props.runtime)
    if (!transport)
      throw {
        error: { code: 'capability_unavailable', retryable: false, message: 'no stream transport' },
      }
    const grant = await executeOperation<import('@adea-ai/types/dev-runtime').DevStreamGrant>(
      props.runtime,
      scope,
      'dev.files.readStream',
      {
        worktreeId: props.worktree.worktreeId,
        path: {
          worktreeId: props.worktree.worktreeId,
          rootIdentity: props.worktree.rootIdentity,
          relativePath: props.relativePath,
        },
        expectedIdentity: pinnedIdentity(),
        direction: 'read',
      },
      {
        kind: 'workspace_root',
        id: props.worktree.worktreeId,
        generation: props.worktree.generation,
      }
    )
    const { readFileViaStream } = await import('../files/file-stream')
    const bytes = await readFileViaStream(transport, grant)
    const entry: FileEntry = {
      path: {
        worktreeId: props.worktree.worktreeId,
        rootIdentity: props.worktree.rootIdentity,
        relativePath: props.relativePath,
      },
      identity: props.identity,
      kind: 'file',
      size: String(bytes.byteLength),
      observedAt: new Date().toISOString(),
    }
    return readResultFromBytes(bytes, { entry })
  }

  async function save(): Promise<void> {
    const currentDocument = document()
    const handle = mirror()
    const scope = props.runtime.preferenceScope?.()
    if (!currentDocument || !handle || !scope) return
    const content = documentToBytes(currentDocument, handle.getText(), 'preserve')
    try {
      if (content.byteLength > CONTROL_INLINE_MAX && streamTransportOf(props.runtime)) {
        await streamSave(content)
      } else {
        await controlSave(content)
      }
      setDirty(false)
      setConflict(false)
      setNotice(undefined)
    } catch (reply) {
      const code = (reply as { error?: { code?: string } })?.error?.code
      if (code === 'file_changed') {
        setConflict(true)
      } else {
        setNotice(describeError(reply))
      }
    }
  }

  async function controlSave(content: Uint8Array): Promise<void> {
    const scope = props.runtime.preferenceScope?.()
    if (!scope) throw { error: { code: 'unauthenticated', message: 'runtime scope missing' } }
    const written = await executeOperation<{ entry: { identity: FileIdentity } }>(
      props.runtime,
      scope,
      'dev.files.write',
      {
        worktreeId: props.worktree.worktreeId,
        path: {
          worktreeId: props.worktree.worktreeId,
          rootIdentity: props.worktree.rootIdentity,
          relativePath: props.relativePath,
        },
        expectedIdentity: pinnedIdentity(),
        content,
        eolPolicy: 'preserve',
      },
      {
        kind: 'workspace_root',
        id: props.worktree.worktreeId,
        generation: props.worktree.generation,
      }
    )
    setPinnedIdentity(written.entry.identity)
  }

  /** Bulk save: the grant pins the identity and declares length + digest;
   *  the provider's atomic rename replaces the file only after a byte-exact,
   *  digest-exact transfer. The live identity is re-read for the next CAS. */
  async function streamSave(content: Uint8Array): Promise<void> {
    const scope = props.runtime.preferenceScope?.()
    if (!scope) throw { error: { code: 'unauthenticated', message: 'runtime scope missing' } }
    const transport = streamTransportOf(props.runtime)
    if (!transport)
      throw {
        error: { code: 'capability_unavailable', retryable: false, message: 'no stream transport' },
      }
    const grant = await executeOperation<import('@adea-ai/types/dev-runtime').DevStreamGrant>(
      props.runtime,
      scope,
      'dev.files.writeStream',
      {
        worktreeId: props.worktree.worktreeId,
        path: {
          worktreeId: props.worktree.worktreeId,
          rootIdentity: props.worktree.rootIdentity,
          relativePath: props.relativePath,
        },
        expectedIdentity: pinnedIdentity(),
        byteLength: String(content.byteLength),
        contentSha256: await sha256Hex(content),
        eolPolicy: 'preserve',
        direction: 'write',
      },
      {
        kind: 'workspace_root',
        id: props.worktree.worktreeId,
        generation: props.worktree.generation,
      }
    )
    const { writeFileViaStream } = await import('../files/file-stream')
    await writeFileViaStream(transport, grant, content)
    const live = await executeOperation<{ identity: FileIdentity }>(
      props.runtime,
      scope,
      'dev.files.stat',
      {
        worktreeId: props.worktree.worktreeId,
        path: {
          worktreeId: props.worktree.worktreeId,
          rootIdentity: props.worktree.rootIdentity,
          relativePath: props.relativePath,
        },
      },
      {
        kind: 'workspace_root',
        id: props.worktree.worktreeId,
        generation: props.worktree.generation,
      }
    )
    setPinnedIdentity(live.identity)
  }

  /** The explicit overwrite: re-stat for the live identity, then write. */
  async function overwrite(): Promise<void> {
    const scope = props.runtime.preferenceScope?.()
    if (!scope) return
    try {
      const stat = await executeOperation<{ identity: FileIdentity }>(
        props.runtime,
        scope,
        'dev.files.stat',
        {
          worktreeId: props.worktree.worktreeId,
          path: {
            worktreeId: props.worktree.worktreeId,
            rootIdentity: props.worktree.rootIdentity,
            relativePath: props.relativePath,
          },
        },
        {
          kind: 'workspace_root',
          id: props.worktree.worktreeId,
          generation: props.worktree.generation,
        }
      )
      setPinnedIdentity(stat.identity)
      setConflict(false)
      await save()
    } catch (reply) {
      setNotice(describeError(reply))
    }
  }

  async function reload(): Promise<void> {
    mirror()?.destroy()
    setMirror(undefined)
    setDirty(false)
    setConflict(false)
    setNotice(undefined)
    await load()
  }

  let surfaceElement: HTMLDivElement | undefined

  return (
    <section class="dev-editor" aria-label={`Editor: ${props.relativePath}`}>
      <div class="dev-editor__banner">
        <span class="dev-files__name">{props.relativePath}</span>
        <Show when={dirty()}>
          <span class="dev-files__badge">edited</span>
        </Show>
        <Show when={readOnlyReason()}>
          <span class="dev-terminal-muted">read-only — {readOnlyReason()}</span>
        </Show>
        <button
          type="button"
          class="dev-icon-button"
          aria-label="Save file"
          disabled={!dirty() || !!readOnlyReason()}
          onClick={() => void save()}
        >
          <Save aria-hidden="true" />
        </button>
        <button
          type="button"
          class="dev-icon-button"
          aria-label="Reload file"
          onClick={() => void reload()}
        >
          <RefreshCw aria-hidden="true" />
        </button>
        <button
          type="button"
          class="dev-icon-button"
          aria-label="Close editor"
          onClick={props.onClose}
        >
          ✕
        </button>
      </div>
      <Show when={conflict()}>
        {(shown) => (
          <div class="dev-editor__banner dev-editor__banner--conflict" role="alert">
            <span>{shown()} — the file changed on disk since it was loaded.</span>
            <button type="button" class="dev-button" onClick={() => void reload()}>
              Reload (discard local edits)
            </button>
            <button type="button" class="dev-button" onClick={() => void overwrite()}>
              Overwrite disk copy
            </button>
          </div>
        )}
      </Show>
      <Show when={notice()}>
        {(shown) => (
          <p class="dev-terminal-muted dev-editor__banner" role="status">
            {shown()}
          </p>
        )}
      </Show>
      <Show when={status() !== 'ready' || !!readOnlyReason()}>
        <Show
          when={!readOnlyReason()}
          fallback={
            <div class="dev-sc__diff" aria-label="Read-only preview">
              {previewText()}
            </div>
          }
        >
          <p class="dev-empty-state">
            {status() === 'loading' ? 'Loading file…' : 'The file could not be opened.'}
          </p>
        </Show>
      </Show>
      <div
        class={cn('dev-editor__surface', { 'dev-editor__surface--hidden': !mirror() })}
        ref={(element) => (surfaceElement = element)}
      />
    </section>
  )
}

function describeError(reply: unknown): string {
  const error = reply as { error?: { code?: string; message?: string } }
  return `${error?.error?.code ?? 'error'}: ${error?.error?.message ?? 'operation failed'}`
}
