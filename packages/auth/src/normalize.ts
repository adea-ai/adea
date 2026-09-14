/**
 * Normalize an email address the way a person actually types or pastes it.
 *
 * The provider's email validation rejects invisible characters even when the
 * address reads correctly — a trailing non-breaking space or a zero-width
 * space from a copy-paste fails with "invalid email" no matter what the
 * person does, because `String.prototype.trim` only removes ASCII whitespace
 * at the ends. NFKC folds fullwidth and lookalike forms (e.g. ＠ → @) and the
 * character class strips every Unicode whitespace plus zero-width markers
 * anywhere in the value; none of them can appear in a deliverable address.
 */
export function normalizeEmail(raw: string): string {
  return raw.normalize('NFKC').replace(/[\p{White_Space}\u200B-\u200D\u2060\uFEFF]/gu, '')
}
