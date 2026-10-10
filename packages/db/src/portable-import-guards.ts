// Portable workspace import guards (M18.02.2, #1226): the pre-write checks.
//
// A bundle is untrusted data. These checks run before any database access: the bundle must
// satisfy the version-1 contract and must hash to its own content digest. The importer
// relies on them, and the unit lane measures them.

import {
  type PortableWorkspaceExport,
  type PortableWorkspaceExportIssue,
  validatePortableWorkspaceExport,
} from '@adea-ai/types'

import { portableContentDigest } from './portable-export-content'

export type PortableImportFailureCode =
  | 'digest_mismatch'
  | 'importer_unavailable'
  | 'invalid_document'
  | 'target_exists'
  | 'unresolved_users'
  | 'verification_failed'

export class PortableImportError extends Error {
  readonly code: PortableImportFailureCode
  readonly issues: readonly PortableWorkspaceExportIssue[]

  constructor(
    code: PortableImportFailureCode,
    message: string,
    issues: readonly PortableWorkspaceExportIssue[] = []
  ) {
    super(message)
    this.name = 'PortableImportError'
    this.code = code
    this.issues = issues
  }
}

/**
 * Validate an untrusted bundle and check its digest. Returns the document, or throws
 * `PortableImportError` before any write could happen.
 */
export function checkPortableBundle(bundle: unknown): PortableWorkspaceExport {
  const validation = validatePortableWorkspaceExport(bundle)
  if (!validation.ok)
    throw new PortableImportError(
      'invalid_document',
      'the bundle does not satisfy the portable export contract',
      validation.issues
    )
  const document: PortableWorkspaceExport = validation.document
  if (portableContentDigest(document.content) !== document.contentDigest.value)
    throw new PortableImportError('digest_mismatch', 'the bundle content does not match its digest')
  return document
}
