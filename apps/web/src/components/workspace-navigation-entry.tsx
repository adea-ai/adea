'use client'

// Workspace entry for both lanes. The desktop runtime renders the same
// navigation component from the shell session bootstrap; the browser renders
// it from the cookie bootstrap. See
// docs/decisions/0006-browser-lanes-and-desktop-shell.md.
import { useEffect, useRef, useState } from 'react'
import { createApiClient } from '@adea-ai/api-client'
import { useWorkspaceBootstrapQuery } from '@adea-ai/data'
import { useWorkspaceStore } from '@adea-ai/state'
import type { WorkspacePlatformServices } from '@adea-ai/workspace-ui/platform'
import { createBrowserSettingsProvider } from '@adea-ai/workspace-ui/preferences'
import { isDesktopRuntime } from '../lib/desktop-bridge'
import { DesktopWorkspaceEntry } from './desktop-workspace-entry'
import { createDeferredPluginsProvider, WorkspaceNavigation } from './workspace-navigation'
import type { WorkspaceShellProps } from './workspace-shell'
import packageJson from '../../package.json'

const appVersion = packageJson.version

export function WorkspaceNavigationEntry({
  virtual,
  virtualProps,
  roomDesigner = false,
}: Readonly<{
  virtual: boolean
  virtualProps: WorkspaceShellProps
  roomDesigner?: boolean
}>) {
  if (isDesktopRuntime()) {
    return (
      <DesktopWorkspaceEntry
        roomDesigner={roomDesigner}
        virtual={virtual}
        virtualProps={virtualProps}
      />
    )
  }
  return (
    <WebNavigationEntry roomDesigner={roomDesigner} virtual={virtual} virtualProps={virtualProps} />
  )
}

function WebNavigationEntry({
  virtual,
  virtualProps,
  roomDesigner = false,
}: Readonly<{
  virtual: boolean
  virtualProps: WorkspaceShellProps
  roomDesigner?: boolean
}>) {
  const [client] = useState(() => createApiClient())
  const workspaceIdRef = useRef<string | undefined>(undefined)
  const userIdRef = useRef<string | undefined>(undefined)
  const [services] = useState<WorkspacePlatformServices>(() => ({
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
      client,
      getWorkspaceId: () => workspaceIdRef.current,
      getUserId: () => userIdRef.current,
      requestedHarness: 'codex',
    }),
    settings: createBrowserSettingsProvider(),
  }))
  const bootstrap = useWorkspaceBootstrapQuery(client)
  const selectedWorkspaceId = useWorkspaceStore((state) => state.selectedWorkspaceId)
  const requestedScene =
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('scene')
      ? new URLSearchParams(window.location.search).get('scene')
      : undefined
  const activeWorkspace =
    bootstrap.data?.workspaces.find(({ id }) => id === selectedWorkspaceId) ??
    bootstrap.data?.workspaces.find(({ scene }) => scene === requestedScene) ??
    bootstrap.data?.activeWorkspace
  const principal = bootstrap.data?.principal
  const accountAuthenticated = Boolean(principal && !principal.temporary)
  const accountLabel = accountAuthenticated
    ? (principal?.displayName ?? 'Account')
    : 'Not signed in'

  useEffect(() => {
    workspaceIdRef.current = activeWorkspace?.id
    userIdRef.current = principal?.userId
  }, [activeWorkspace?.id, principal?.userId])

  return (
    <WorkspaceNavigation
      account={{
        authenticated: accountAuthenticated,
        busy: services.account?.busy ?? false,
        label: accountLabel,
        onSignIn: () => services.account?.onSignIn(),
        onSignOut: () => services.account?.onSignOut(),
      }}
      activeWorkspace={activeWorkspace}
      client={client}
      platform="web"
      roomDesigner={roomDesigner}
      services={services}
      virtual={virtual}
      virtualProps={virtualProps}
      workspaces={bootstrap.data?.workspaces ?? []}
    />
  )
}
