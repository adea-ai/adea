import { describe, expect, test } from 'bun:test'

import {
  PORTABLE_WORKSPACE_EXPORT_EXCLUSIONS,
  PORTABLE_WORKSPACE_EXPORT_FORMAT,
  type PortableWorkspaceExport,
  type PortableWorkspaceExportContent,
} from '@adea-ai/types/portable-export'

import { portableContentDigest } from '../../src/portable-export-content'
import { importPortableWorkspace } from '../../src/portable-import'
import { PortableImportError } from '../../src/portable-import-guards'

// Lives with the integration tests because importing the importer pulls the database readers into
// the module graph, and the unit coverage lane counts every module the graph loads.

const workspaceId = '00000000-0000-4000-8000-0000000000aa'
const ownerId = '00000000-0000-4000-8000-0000000000bb'
const at = '2026-10-01T10:00:00.000Z'

/** The smallest document the contract accepts: one workspace and nothing else. */
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
    exportedBy: { role: 'owner', userId: ownerId },
    format: PORTABLE_WORKSPACE_EXPORT_FORMAT,
    formatVersion: 1,
  }
}

describe('portable import entry point', () => {
  test('refuses prototype-named unknown fields before any database transaction', async () => {
    const withProto = JSON.parse(JSON.stringify(minimalDocument())) as PortableWorkspaceExport
    const protoField = JSON.parse('{"__proto__":{"hidden":"not part of v1"}}')
    Object.defineProperty(
      withProto.content.workspace,
      '__proto__',
      Object.getOwnPropertyDescriptor(protoField, '__proto__')!
    )
    withProto.contentDigest.value = portableContentDigest(withProto.content)

    let transactionStarted = false
    const database = {
      transaction: async () => {
        transactionStarted = true
        throw new Error('invalid input reached the database transaction')
      },
    }
    const error = await importPortableWorkspace(database as never, {
      bundle: withProto,
      importer: { kind: 'user', userId: ownerId },
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(PortableImportError)
    expect((error as PortableImportError).code).toBe('invalid_document')
    expect((error as PortableImportError).issues).toContainEqual(
      expect.objectContaining({
        code: 'unknown_field',
        path: 'document.content.workspace.__proto__',
      })
    )
    expect(transactionStarted).toBe(false)
  })
})
