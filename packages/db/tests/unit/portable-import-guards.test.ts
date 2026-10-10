import { describe, expect, test } from 'bun:test'

import {
  PORTABLE_WORKSPACE_EXPORT_EXCLUSIONS,
  PORTABLE_WORKSPACE_EXPORT_FORMAT,
  type PortableWorkspaceExport,
  type PortableWorkspaceExportContent,
  validatePortableWorkspaceExport,
} from '@adea-ai/types'

import type { AgentHqDatabase } from '../../src/connection'
import { portableContentDigest } from '../../src/portable-export'
import { importPortableWorkspace, PortableImportError } from '../../src/portable-import'

const workspaceId = '00000000-0000-4000-8000-0000000000aa'
const importerId = '00000000-0000-4000-8000-0000000000bb'
const at = '2026-10-01T10:00:00.000Z'

// Any touch of the destination fails the test: every refusal below must happen
// before the first database call.
const untouchedDatabase = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`the destination was touched (${String(property)})`)
    },
  }
) as unknown as AgentHqDatabase

function minimalDocument(): PortableWorkspaceExport {
  const content: PortableWorkspaceExportContent = {
    agents: [],
    channels: [],
    contentRefs: [],
    executionAttempts: [],
    messages: [],
    projects: [],
    taskDependencies: [],
    tasks: [],
    users: [],
    workspace: {
      accent: null,
      createdAt: at,
      logoKind: 'box',
      logoValue: null,
      name: 'Restored',
      scene: 'home',
      updatedAt: at,
      version: 1,
      workspaceId,
    },
  }
  return {
    content,
    contentDigest: { algorithm: 'sha256', value: portableContentDigest(content) },
    exclusions: PORTABLE_WORKSPACE_EXPORT_EXCLUSIONS,
    exportedAt: at,
    exportedBy: { role: 'owner', userId: importerId },
    format: PORTABLE_WORKSPACE_EXPORT_FORMAT,
    formatVersion: 1,
  }
}

describe('portable import refusals before any write', () => {
  test('the minimal document is itself a valid version-1 export', () => {
    expect(validatePortableWorkspaceExport(minimalDocument()).ok).toBe(true)
  })

  test('refuses a bundle that fails the contract without touching the destination', async () => {
    const bundle = { ...minimalDocument(), format: 'adea.other' }
    const error = await importPortableWorkspace(untouchedDatabase, {
      bundle,
      importer: { kind: 'user', userId: importerId },
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(PortableImportError)
    expect((error as PortableImportError).code).toBe('invalid_document')
    expect((error as PortableImportError).issues.length).toBeGreaterThan(0)
  })

  test('refuses content that does not match its digest', async () => {
    const document = minimalDocument()
    const tampered = {
      ...document,
      content: {
        ...document.content,
        workspace: { ...document.content.workspace, name: 'Edited' },
      },
    }
    const error = await importPortableWorkspace(untouchedDatabase, {
      bundle: tampered,
      importer: { kind: 'user', userId: importerId },
    }).catch((caught: unknown) => caught)
    expect((error as PortableImportError).code).toBe('digest_mismatch')
  })
})
