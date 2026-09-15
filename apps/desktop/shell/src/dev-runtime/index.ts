/**
 * Privileged Dev Runtime host registration is intentionally unavailable.
 *
 * Issue #395 owns this seam, but M10 #33 remains the sole authority for an
 * authenticated command channel, credentials, scope, replay protection, and
 * capability enforcement. Do not export a command handler from here until
 * those production authorities and their acceptance tests exist.
 */
export const devRuntimeHostRegistration = Object.freeze({
  status: 'blocked' as const,
  reason: 'm10_authority_unavailable' as const,
  registeredCommands: Object.freeze([] as readonly string[]),
})
