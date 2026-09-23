// Default-deny policy for sensitive paths (#622).
//
// Containment proves a path is INSIDE an approved root; it says nothing about
// whether the path is one a grant should ever expose. Approving a project (or,
// worse, a home directory) therefore used to make the user's key material and
// credential stores readable through the ordinary file operations.
//
// This module is the sensitivity half, and it is deliberately fail-closed and
// deliberately dumb: name and directory rules, evaluated on the *resolved*
// path so a symlink cannot route around them. Nothing here reads a file or
// inspects contents — a path is denied by where it is and what it is called,
// which is what lets the check sit in the same place as containment.
//
// Deliberately NOT denied: project dotfiles an approved root legitimately
// needs — `.env`, `.npmrc`, `.docker/compose`, test fixtures. A `.env` inside
// an approved project is how the harness runs its own tests. Expansion past a
// deny rule is an owner-approval decision and is tracked on #622, not
// implemented here.

/** Bumped when a rule changes meaning. The version travels with the refusal so
 *  a client or an audit record can tell which policy refused a path. */
export const DENY_POLICY_VERSION = 1

export type DenyVerdict =
  | Readonly<{ denied: false }>
  | Readonly<{ denied: true; rule: DenyRuleId; policyVersion: number; reason: string }>

export type DenyRuleId = 'key_material' | 'credential_store' | 'agent_hq_authority'

export type DenyPolicyOptions = Readonly<{
  /**
   * Absolute directories Agent HQ owns — its encrypted local-content store,
   * the credential vault, the dev-runtime state. No grant may expose them,
   * whatever the user approved.
   */
  protectedRoots?: readonly string[]
}>

/** Private keys and keystores, by file name. Public counterparts are allowed:
 *  `id_ed25519.pub` and `cert.pem` are not secrets, so the patterns below name
 *  only the private forms. */
const DENIED_FILE_PATTERNS: readonly RegExp[] = [
  /\.p12$/i,
  /\.pfx$/i,
  /\.keystore$/i,
  /\.jks$/i,
  /\.key$/i,
  /^id_rsa$/,
  /^id_ed25519$/,
  /^id_ecdsa$/,
  /^id_dsa$/,
]

/** Credential stores, by directory. Matched anywhere in the resolved path, not
 *  only under the home directory: a vendored copy is no less a credential
 *  store, and matching narrowly would make the rule depend on `$HOME`. */
const DENIED_DIRECTORY_SUFFIXES: readonly string[] = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.docker',
  '.config/gcloud',
  '.config/gh',
  '.config/age',
  'Library/Keychains',
]

function toPosix(value: string): string {
  return value.replaceAll('\\', '/')
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

/**
 * Evaluates the default-deny policy for a resolved absolute path. `resolved`
 * must be the realpath of the deepest existing component (what containment
 * already computes) so a symlinked route to a denied directory is caught, and
 * callers should evaluate the *target* path as well so a denied file NAME is
 * caught before it exists (a create).
 */
export function evaluateDenyPolicy(resolved: string, options: DenyPolicyOptions = {}): DenyVerdict {
  const path = toPosix(resolved)

  for (const root of options.protectedRoots ?? []) {
    if (root.length === 0) continue
    const canonical = stripTrailingSlash(toPosix(root))
    if (path === canonical || path.startsWith(`${canonical}/`)) {
      return {
        denied: true,
        rule: 'agent_hq_authority',
        policyVersion: DENY_POLICY_VERSION,
        reason: 'path is inside an Agent HQ authority directory and is not exposed to grants',
      }
    }
  }

  const segments = path.split('/')
  const name = segments[segments.length - 1] ?? ''
  for (const pattern of DENIED_FILE_PATTERNS) {
    if (pattern.test(name)) {
      return {
        denied: true,
        rule: 'key_material',
        policyVersion: DENY_POLICY_VERSION,
        reason: 'path names private key material',
      }
    }
  }

  const directory = segments.slice(0, -1).join('/')
  for (const suffix of DENIED_DIRECTORY_SUFFIXES) {
    if (directory === suffix || directory.endsWith(`/${suffix}`) || path.includes(`/${suffix}/`)) {
      return {
        denied: true,
        rule: 'credential_store',
        policyVersion: DENY_POLICY_VERSION,
        reason: `path is inside a credential store (${suffix})`,
      }
    }
  }

  return { denied: false }
}
