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
 * Runs one key store operation, and reports the OS credential store's own
 * refusal with the boot's fixed reason.
 *
 * The vault's own refusal is kept as the failure's cause, so its diagnosis is
 * not lost, and the fixed reason still carries no store detail.
 */
function reportWithFixedReason<T>(operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    if (error instanceof DevAuthorityError && error.code === 'auth_required') {
      const failure = new DevAuthorityError('auth_required', UNAVAILABLE_CREDENTIAL_STORE_REASON)
      failure.cause = error
      throw failure
    }
    throw error
  }
}

/**
 * A key store that reports the OS credential store's own refusal with the
 * boot's fixed reason.
 *
 * The refusal can arrive while the store is resolved, or later, while the
 * Dev Runtime host composes and reads the vault key — the legacy path reads
 * the key only then. The boot needs one reason either way, and it needs the
 * failure its composition is allowed to degrade on to be that one.
 */
function createFixedReasonKeyStore(inner: VaultKeyStore): VaultKeyStore {
  return {
    get: (service, account) => reportWithFixedReason(() => inner.get(service, account)),
    set: (service, account, key) => reportWithFixedReason(() => inner.set(service, account, key)),
    delete: (service, account) => reportWithFixedReason(() => inner.delete(service, account)),
  }
}

/**
 * Resolves the boot-time credential store.
 *
 * The OS credential store is used when it answers. When it does not, the
 * application still boots with a store that fails closed, and the result says
 * so, so the shell can report the degradation once.
 *
 * The store it returns reports a refusal with the boot's fixed reason, so a
 * refusal that arrives later — while the Dev Runtime host composes — is the
 * same failure the boot already knows how to degrade on.
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
    return { store: createFixedReasonKeyStore(store), degraded: false, reason: null }
  } catch (error) {
    // The vault owns this classification. A typed fault that is not the store
    // being unable to answer — two key stores that disagree, a key of the
    // wrong size — is an integrity condition, and it must not be relabelled
    // as an absent store: it fails loudly, with the vault's own diagnosis.
    if (error instanceof DevAuthorityError && error.code !== 'auth_required') {
      throw error
    }
    return {
      store: createUnavailableVaultKeyStore(),
      degraded: true,
      reason: UNAVAILABLE_CREDENTIAL_STORE_REASON,
    }
  }
}
