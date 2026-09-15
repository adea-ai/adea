/**
 * Normalize an email address the way a person actually types or pastes it.
 *
 * The auth provider's email validation is ASCII-only and rejects anything
 * else, while real input carries fullwidth/lookalike forms (＠, Cyrillic
 * lookalikes) and invisible characters (soft hyphens, non-breaking and
 * zero-width spaces from copy-paste) that read as a valid address. NFKC
 * folds the foldable forms, then everything outside the ASCII email charset
 * is dropped — the provider would reject the address for any such character
 * anyway, so whitelisting exactly what it accepts can only make a
 * deliverable address more correct, never less.
 */
export function normalizeEmail(raw: string): string {
  return raw.normalize('NFKC').replace(/[^A-Za-z0-9@._+-]/g, '')
}
