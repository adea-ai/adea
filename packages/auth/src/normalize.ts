/**
 * Normalize an email address the way a person actually types or pastes it.
 *
 * The auth provider's email validation is ASCII-only and strict about
 * punctuation: it rejects invisible characters (soft hyphens, non-breaking
 * and zero-width spaces from copy-paste), fullwidth/lookalike forms (＠), and
 * dot damage — a sentence period glued to the end ("…com."), a leading dot,
 * or doubled dots. NFKC folds the foldable forms, everything outside the
 * ASCII email charset is dropped, and dot runs collapse with edge dots
 * removed — producing the address the person meant, which the provider would
 * otherwise reject no matter what they did.
 */
export function normalizeEmail(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9@._+-]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.]+|[.]+$/g, '')
}
