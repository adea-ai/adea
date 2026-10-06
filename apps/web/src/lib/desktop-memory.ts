// Workspace memory over the desktop bridge (ADR 0012; docs/specs/local-content.md
// "Workspace memory"). Browser-safe by construction: it resolves only through
// the injected `window.__adeaDesktop` bridge, so the web lane never constructs
// it and the Memory settings section renders its typed unavailable state.
// The shell admits only the workspace its own scope authority holds; a
// refusal arrives as a stable `memory_*` code the settings model maps to copy.
import type { WorkspaceMemoryEntry, WorkspaceMemorySnapshot } from '@adea-ai/types'
import type { WorkspaceMemoryService } from '@adea-ai/workspace-ui/platform'

import { invoke } from './desktop-bridge'

type EntryRef = Readonly<{ workspaceId: string; entryId: string; expectedRevision: number }>

export const desktopMemoryService: WorkspaceMemoryService = Object.freeze({
  list(workspaceId: string) {
    return invoke<WorkspaceMemorySnapshot>('memory_list', { workspaceId })
  },
  create(input: Readonly<{ workspaceId: string; text: string }>) {
    return invoke<WorkspaceMemoryEntry>('memory_create', {
      workspaceId: input.workspaceId,
      text: input.text,
    })
  },
  update(input: EntryRef & Readonly<{ text: string }>) {
    return invoke<WorkspaceMemoryEntry>('memory_update', {
      workspaceId: input.workspaceId,
      entryId: input.entryId,
      expectedRevision: input.expectedRevision,
      text: input.text,
    })
  },
  async remove(input: EntryRef) {
    await invoke<null>('memory_delete', {
      workspaceId: input.workspaceId,
      entryId: input.entryId,
      expectedRevision: input.expectedRevision,
    })
  },
  acceptProposal(input: EntryRef) {
    return invoke<WorkspaceMemoryEntry>('memory_accept_proposal', {
      workspaceId: input.workspaceId,
      entryId: input.entryId,
      expectedRevision: input.expectedRevision,
    })
  },
  async rejectProposal(input: EntryRef) {
    await invoke<null>('memory_reject_proposal', {
      workspaceId: input.workspaceId,
      entryId: input.entryId,
      expectedRevision: input.expectedRevision,
    })
  },
  async setInjectionEnabled(input: Readonly<{ workspaceId: string; enabled: boolean }>) {
    const result = await invoke<Readonly<{ injectionEnabled: boolean }>>('memory_injection_save', {
      workspaceId: input.workspaceId,
      enabled: input.enabled,
    })
    return result.injectionEnabled
  },
})
