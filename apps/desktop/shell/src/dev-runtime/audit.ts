// Secret-free, path-free structured audit trail for the M10 #34 grant
// authorities. Entries are append-only JSONL: one action, one subject id, one
// outcome, plus a bounded, scrubbed detail map. Canonical roots, host paths,
// and credential material of any kind are refused at write time so a leaked
// log file can never carry them.
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { DevAuthorityError, nowIso } from './authority'

export type AuthorityAuditOutcome = 'granted' | 'denied' | 'revoked' | 'failed' | 'recovered'

export type AuthorityAuditEntry = Readonly<{
  action: string
  subjectId: string
  outcome: AuthorityAuditOutcome
  detail?: Readonly<Record<string, string>>
}>

const FORBIDDEN_DETAIL_PATTERN =
  /secret|password|token|plaintext|cookie|authorization|credential|path|root\b|key$/i
const DETAIL_KEY_MAX = 64
const DETAIL_VALUE_MAX = 256

function assertDetailIsScrubbed(detail: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(detail)) {
    if (key.length < 1 || key.length > DETAIL_KEY_MAX || FORBIDDEN_DETAIL_PATTERN.test(key)) {
      throw new Error(`forbidden audit detail key: ${key}`)
    }
    if (typeof value !== 'string' || value.length < 1 || value.length > DETAIL_VALUE_MAX) {
      throw new Error(`forbidden audit detail value for: ${key}`)
    }
  }
}

export function createAuthorityAudit(options: { file: string }) {
  const { file } = options

  function append(entry: AuthorityAuditEntry): void {
    if (entry.action.length < 1 || entry.action.length > 128) {
      throw new Error('forbidden audit action')
    }
    if (entry.subjectId.length < 1 || entry.subjectId.length > 256) {
      throw new Error('forbidden audit subject id')
    }
    if (entry.detail) assertDetailIsScrubbed(entry.detail)
    const line = `${JSON.stringify({
      at: nowIso(),
      action: entry.action,
      subjectId: entry.subjectId,
      outcome: entry.outcome,
      ...(entry.detail ? { detail: entry.detail } : {}),
    })}\n`
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    appendFileSync(file, line, { mode: 0o600 })
  }

  return Object.freeze({ append })
}

export type AuthorityAudit = ReturnType<typeof createAuthorityAudit>

export function auditOutcomeForError(error: unknown): AuthorityAuditOutcome {
  if (error instanceof DevAuthorityError) {
    return error.code === 'unauthorized' || error.code === 'unauthorized_root' ? 'denied' : 'failed'
  }
  return 'failed'
}
