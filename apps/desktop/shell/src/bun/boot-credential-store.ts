// The desktop shell's boot-time credential store.
//
// The Dev Runtime's vault master key lives in the OS credential store. That
// store can be unavailable for reasons that have nothing to do with the
// application: a host with no default keychain, a locked keychain, an
// operating-system authorization the operator has not granted, or a sandbox
// that deliberately keeps the login keychain out of the search list. When the
// store cannot answer, the BOOT must not take the whole application down with
// it.
//
// This is the same contract the shell already applies to its other boot-time
// subsystems ("degraded, not faked"): a bundle whose component manifest fails
// to load still boots, with truthful-empty listings and typed
// `capability_unavailable` stops, rather than fabricating state or dying.
//
// The fallback store FAILS CLOSED. Every operation throws `auth_required`, and
// the read path never answers "absent": an absent answer would let the vault
// generate a replacement key and strand the sealed content behind the real
// one. Failing closed keeps the content unreadable and the key unchanged.
//
// The reason string is fixed and secret-free. It never carries a store
// message, a path, an account name or a keychain service.
import { DevAuthorityError } from '../dev-runtime/authority'
import {
  createBunSecretsVaultKeyStore,
  createSystemVaultKeyStore,
  type BunSecretsApi,
  type VaultKeyStore,
} from '../dev-runtime/vault'

/** The fixed, secret-free reason the boot reports when the store is absent. */
export const UNAVAILABLE_CREDENTIAL_STORE_REASON = 'the OS credential store is unavailable'

/** What the boot resolved, and whether it had to degrade. */
export type BootCredentialStore = Readonly<{
  /** The store every vault operation uses. */
  store: VaultKeyStore
  /** True when the OS credential store could not be reached. */
  degraded: boolean
  /** The fixed reason for the degradation, or null when the store answered. */
  reason: string | null
}>

/**
 * A key store that cannot be used at all. Every operation throws the typed
 * `auth_required` error, so a caller that needs the vault key fails closed
 * instead of reading an absent value or writing a replacement.
 */
export function createUnavailableVaultKeyStore(
  reason: string = UNAVAILABLE_CREDENTIAL_STORE_REASON
): VaultKeyStore {
  const fail = (): never => {
    throw new DevAuthorityError('auth_required', reason)
  }
  return {
    get: fail,
    set: fail,
    delete: fail,
  }
}

/**
 * Whether an error is the boot's own "the OS credential store is unavailable"
 * failure, and nothing else.
 *
 * The boot degrades on THIS failure and only on it: any other composition
 * failure is a real fault and must keep failing loudly.
 */
export function isUnavailableCredentialStoreError(error: unknown): boolean {
  return error instanceof DevAuthorityError && error.message === UNAVAILABLE_CREDENTIAL_STORE_REASON
}

/**
 * Resolves the boot-time credential store.
 *
 * The OS credential store is used when it answers. When it does not, the
 * application still boots with a store that fails closed, and the result says
 * so, so the shell can report the degradation once.
 *
 * The dependencies are injectable so the decision can be exercised without a
 * credential store of any kind: a test injects a legacy store and a Bun
 * secrets port, and never reaches a native backend.
 */
export async function resolveBootCredentialStore(
  dependencies: {
    legacyStore?: VaultKeyStore
    secrets?: BunSecretsApi
    runtimeVersion?: string
  } = {}
): Promise<BootCredentialStore> {
  try {
    const store = await createBunSecretsVaultKeyStore({
      legacyStore: dependencies.legacyStore ?? createSystemVaultKeyStore(),
      secrets: dependencies.secrets,
      runtimeVersion: dependencies.runtimeVersion,
    })
    return { store, degraded: false, reason: null }
  } catch {
    return {
      store: createUnavailableVaultKeyStore(),
      degraded: true,
      reason: UNAVAILABLE_CREDENTIAL_STORE_REASON,
    }
  }
}
