import type { AgentHqApiClient } from '@adea-ai/api-client'
import type { AccountDirectoryApiClient } from '@adea-ai/api-client/account-directory'
import type { DesktopSession } from '@adea-ai/auth/desktop'
import type { DesktopRuntime } from '../src/lib/desktop-runtime'
import {
  recordBootstrap,
  rotationPrincipal,
  rotationSessions,
  rotationWorkspace,
  unexpectedOperation,
} from './desktop-entry-auth-rotation-state'

const runtime: DesktopRuntime = {
  beginAuthorization: async () => unexpectedOperation('beginAuthorization'),
  cancelAuthorization: async () => unexpectedOperation('cancelAuthorization'),
  consumeAuthorization: async (callback) => {
    if (callback !== 'adea://auth/callback?code=fixture-code&state=fixture-state')
      return unexpectedOperation('unexpected auth callback')
    return {
      code: 'fixture-code',
      codeVerifier: 'fixture-verifier',
      nonce: 'fixture-nonce',
      redirectUri: 'adea://auth/callback',
    }
  },
  authorizationUrl: () => unexpectedOperation('authorizationUrl'),
  createClient(session?: DesktopSession) {
    // The real bootstrap function and deletion attachment use this external API
    // double. Unimplemented cloud operations must fail instead of reaching HTTP.
    return {
      async bootstrapWorkspace() {
        recordBootstrap(session)
        return {
          activeWorkspace: { ...rotationWorkspace },
          principal: {
            displayName: 'Fixture account',
            temporary: false,
            userId: rotationPrincipal(session),
          },
          sessionRotated: false,
          workspaces: [{ ...rotationWorkspace }],
        }
      },
      deleteWorkspace: async () => unexpectedOperation('deleteWorkspace'),
      claimTemporaryWorkspace: async () => unexpectedOperation('claimTemporaryWorkspace'),
    } as unknown as AgentHqApiClient
  },
  createAccountDirectoryClient: () => ({}) as AccountDirectoryApiClient,
  sessionManager: {
    restore: async () => ({ status: 'authenticated', session: rotationSessions[0]! }),
    completeSignIn: async (exchange) => {
      if (exchange.code !== 'fixture-code') return unexpectedOperation('unexpected exchange')
      return { status: 'authenticated', session: rotationSessions[1]! }
    },
    revoke: async () => unexpectedOperation('revoke'),
    signOut: async () => unexpectedOperation('signOut'),
  },
  temporaryVault: {
    load: async () => null,
    clear: async () => unexpectedOperation('clear guest credential'),
    save: async () => unexpectedOperation('save guest credential'),
  },
  getUserVersion: async () => '0.0.0-fixture',
}

/** External auth broker double; the real Entry owns callback and state changes. */
export function desktopRuntime(): DesktopRuntime {
  return runtime
}
