import { describe, expect, test } from 'bun:test'

import {
  PORTABLE_WORKSPACE_EXPORT_EXCLUSIONS,
  PORTABLE_WORKSPACE_EXPORT_FORMAT,
  type PortableWorkspaceExport,
  type PortableWorkspaceExportContent,
} from '@adea-ai/types'

import { portableContentDigest } from '../../src/portable-export-content'
import { checkPortableBundle, PortableImportError } from '../../src/portable-import-guards'

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

function refusalOf(bundle: unknown): PortableImportError {
  try {
    checkPortableBundle(bundle)
  } catch (error) {
    return error as PortableImportError
  }
  throw new Error('expected the bundle to be refused')
}

describe('portable import guards', () => {
  test('a version-1 document with a matching digest passes unchanged', () => {
    const document = minimalDocument()
    expect(checkPortableBundle(document)).toEqual(document)
  })

  test('refuses a bundle that fails the contract, with issue paths and no bundle values', () => {
    const document = { ...minimalDocument(), format: 'adea.other' }
    const error = refusalOf(document)
    expect(error).toBeInstanceOf(PortableImportError)
    expect(error.code).toBe('invalid_document')
    expect(error.issues.map((issue) => issue.path)).toContain('document.format')
    expect(JSON.stringify(error.issues)).not.toContain('adea.other')
  })

  test('refuses content that does not hash to its digest', () => {
    const document = minimalDocument()
    const tampered = {
      ...document,
      content: {
        ...document.content,
        workspace: { ...document.content.workspace, name: 'Edited' },
      },
    }
    expect(refusalOf(tampered).code).toBe('digest_mismatch')
  })

  test('refuses a non-object bundle as an invalid document', () => {
    expect(refusalOf('not a bundle').code).toBe('invalid_document')
    expect(refusalOf(null).code).toBe('invalid_document')
  })
})
