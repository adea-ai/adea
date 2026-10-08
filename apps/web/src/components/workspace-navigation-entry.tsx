// Workspace entry for both lanes. The desktop runtime renders the same
// navigation component from the shell session bootstrap; the browser renders
// it from the cookie bootstrap. See
// docs/decisions/0006-browser-lanes-and-desktop-shell.md.
import { createApiClient } from '@adea-ai/api-client'
import { settledData, useWorkspaceBootstrapQuery } from '@adea-ai/data'
import { useWorkspaceState } from '@adea-ai/state'
import type { WorkspacePlatformServices } from '@adea-ai/workspace-ui/platform'
import { createBrowserSettingsProvider } from '@adea-ai/workspace-ui/preferences'
import { isDesktopRuntime } from '../lib/desktop-bridge'
import { lazy } from 'solid-js'
import { createDeferredPluginsProvider, WorkspaceNavigation } from './workspace-navigation'
import type { WorkspaceShellProps } from './workspace-shell'
import packageJson from '../../package.json'

// Both lanes remain available in local development. The production web build
// excludes the native bootstrap; the packaged desktop build retains it.
declare const __ADEA_DESKTOP_COMPONENTS__: boolean

const appVersion = packageJson.version

const requestedScene = () =>
  typeof window === 'undefined'
    ? undefined
    : (new URLSearchParams(window.location.search).get('scene') ?? undefined)

export function WorkspaceNavigationEntry(props: {
  virtual: boolean
  virtualProps: WorkspaceShellProps
  characterDesigner?: boolean
  roomDesigner?: boolean
}) {
  if (__ADEA_DESKTOP_COMPONENTS__ && isDesktopRuntime()) {
    const DesktopWorkspaceEntry = lazy(() =>
      import('./desktop-workspace-entry').then((module) => ({
        default: module.DesktopWorkspaceEntry,
      }))
    )
    return (
      <DesktopWorkspaceEntry
        characterDesigner={props.characterDesigner ?? false}
        roomDesigner={props.roomDesigner ?? false}
        virtual={props.virtual}
        virtualProps={props.virtualProps}
      />
    )
  }
  return (
    <WebNavigationEntry
      characterDesigner={props.characterDesigner ?? false}
      roomDesigner={props.roomDesigner ?? false}
      virtual={props.virtual}
      virtualProps={props.virtualProps}
    />
  )
}

function WebNavigationEntry(props: {
  virtual: boolean
  virtualProps: WorkspaceShellProps
  characterDesigner?: boolean
  roomDesigner?: boolean
}) {
  const client = createApiClient()
  const bootstrap = useWorkspaceBootstrapQuery(client)
  const selectedWorkspaceId = useWorkspaceState((state) => state.selectedWorkspaceId)
  const bootstrapData = () => settledData(bootstrap)
  const activeWorkspace = () =>
    bootstrapData()?.workspaces.find(({ id }) => id === selectedWorkspaceId()) ??
    bootstrapData()?.workspaces.find(({ scene }) => scene === requestedScene()) ??
    bootstrapData()?.activeWorkspace
  const principal = () => bootstrapData()?.principal
  const accountAuthenticated = () => Boolean(principal() && !principal()!.temporary)
  const accountLabel = () =>
    accountAuthenticated() ? (principal()?.displayName ?? 'Account') : 'Not signed in'
  // The plugins provider reads these lazily, so accessors deliver the current
  // ids directly — no mutable variables synchronized through an effect.
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
      client,
      getWorkspaceId: () => activeWorkspace()?.id,
      getUserId: () => principal()?.userId,
      requestedHarness: 'codex',
    }),
    settings: createBrowserSettingsProvider(),
  }

  return (
    <WorkspaceNavigation
      account={{
        authenticated: accountAuthenticated(),
        busy: services.account?.busy ?? false,
        label: accountLabel(),
        onSignIn: () => services.account?.onSignIn(),
        onSignOut: () => services.account?.onSignOut(),
      }}
      accountPrincipalId={() => principal()?.userId ?? null}
      activeWorkspace={activeWorkspace()}
      client={client}
      platform="web"
      characterDesigner={props.characterDesigner ?? false}
      roomDesigner={props.roomDesigner ?? false}
      services={services}
      virtual={props.virtual}
      virtualProps={props.virtualProps}
      workspaces={bootstrapData()?.workspaces ?? []}
    />
  )
}
