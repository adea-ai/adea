'use client'

// Workspace entry for both lanes. The desktop runtime renders the same
// navigation component from the shell session bootstrap; the browser renders
// it from the cookie bootstrap. See
// docs/decisions/0006-browser-lanes-and-desktop-shell.md.
import { createEffect, createSignal } from 'solid-js'
import { createApiClient } from '@adea-ai/api-client'
import { settledData, useWorkspaceBootstrapQuery } from '@adea-ai/data'
import { useWorkspaceState } from '@adea-ai/state'
import type { WorkspacePlatformServices } from '@adea-ai/workspace-ui/platform'
import { createBrowserSettingsProvider } from '@adea-ai/workspace-ui/preferences'
import { isDesktopRuntime } from '../lib/desktop-bridge'
import { DesktopWorkspaceEntry } from './desktop-workspace-entry'
import { createDeferredPluginsProvider, WorkspaceNavigation } from './workspace-navigation'
import type { WorkspaceShellProps } from './workspace-shell'
import packageJson from '../../package.json'

const appVersion = packageJson.version

export function WorkspaceNavigationEntry(props: {
  virtual: boolean
  virtualProps: WorkspaceShellProps
  roomDesigner?: boolean
}) {
  if (isDesktopRuntime()) {
    return (
      <DesktopWorkspaceEntry
        roomDesigner={props.roomDesigner ?? false}
        virtual={props.virtual}
        virtualProps={props.virtualProps}
      />
    )
  }
  return (
    <WebNavigationEntry
      roomDesigner={props.roomDesigner ?? false}
      virtual={props.virtual}
      virtualProps={props.virtualProps}
    />
  )
}

function WebNavigationEntry(props: {
  virtual: boolean
  virtualProps: WorkspaceShellProps
  roomDesigner?: boolean
}) {
  const [client] = createSignal(createApiClient())
  let workspaceId: string | undefined
  let userId: string | undefined
  const services: WorkspacePlatformServices = {
    account: {
      onSignIn: () => window.location.assign('/auth/sign-in?returnTo=%2F'),
      onSignOut: async () => {
        const { createNeonClientAdapter } = await import('@adea-ai/auth/client')
        await createNeonClientAdapter().signOut()
        window.location.assign('/')
      },
    },
    app: { name: 'Adea', platform: 'web', version: appVersion },
    plugins: createDeferredPluginsProvider({
      client: client(),
      getWorkspaceId: () => workspaceId,
      getUserId: () => userId,
      requestedHarness: 'codex',
    }),
    settings: createBrowserSettingsProvider(),
  }
  const bootstrap = useWorkspaceBootstrapQuery(client())
  const selectedWorkspaceId = useWorkspaceState((state) => state.selectedWorkspaceId)
  const requestedScene = () =>
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('scene')
      ? new URLSearchParams(window.location.search).get('scene')
      : undefined
  const bootstrapData = () => settledData(bootstrap)
  const activeWorkspace = () =>
    bootstrapData()?.workspaces.find(({ id }) => id === selectedWorkspaceId()) ??
    bootstrapData()?.workspaces.find(({ scene }) => scene === requestedScene()) ??
    bootstrapData()?.activeWorkspace
  const principal = () => bootstrapData()?.principal
  const accountAuthenticated = () => Boolean(principal() && !principal()!.temporary)
  const accountLabel = () =>
    accountAuthenticated() ? (principal()?.displayName ?? 'Account') : 'Not signed in'

  createEffect(() => {
    workspaceId = activeWorkspace()?.id
    userId = principal()?.userId
  })

  return (
    <WorkspaceNavigation
      account={{
        authenticated: accountAuthenticated(),
        busy: services.account?.busy ?? false,
        label: accountLabel(),
        onSignIn: () => services.account?.onSignIn(),
        onSignOut: () => services.account?.onSignOut(),
      }}
      activeWorkspace={activeWorkspace()}
      client={client()}
      platform="web"
      roomDesigner={props.roomDesigner ?? false}
      services={services}
      virtual={props.virtual}
      virtualProps={props.virtualProps}
      workspaces={bootstrapData()?.workspaces ?? []}
    />
  )
}
