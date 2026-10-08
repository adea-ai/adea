import type { JSX } from 'solid-js'
import type { DevRuntimeService } from '@adea-ai/dev-view/platform'
import type { DevCommand, DevReply, Scope } from '@adea-ai/types/dev-runtime'

/**
 * The detailed create-project flow's host seam: the host that can back
 * "Add project" with a Dev Runtime injects this, and the mounting shell opens
 * the detailed dialog (name the cloud project, then optionally bind a local
 * repository) instead of the basic name-and-icon one. `scope` and `execute`
 * drive the repository commands (`dev.project.*`), `knownProjectNames` feeds
 * the import preview's duplicate state, and `onCreateProject` names the cloud
 * project first and resolves the id the binding is keyed by.
 */
export type DevProjectFlow = Readonly<{
  /** The host owns the detailed renderer and its live announcements. */
  renderDialog(props: {
    flow: DevProjectFlow
    workspaceName: string
    onImported(): void
    onClose(): void
  }): JSX.Element
  scope: Scope
  execute(command: DevCommand): Promise<DevReply>
  knownProjectNames: readonly string[]
  onCreateProject(name: string): Promise<string>
  /**
   * The host's native folder picker for the authorize step, when it has one.
   * Resolving `undefined` or `null` means the user cancelled (or the host
   * could not open a picker); the typed path input remains the fallback either
   * way, and the picked path still goes through `dev.project.authorizeRoot` —
   * the picker never widens authorization.
   */
  pickFolder?: () => Promise<string | null | undefined>
}>

/** Which create-project dialog a mounting host gets. */
export type CreateProjectSurface = 'detailed' | 'basic'

/**
 * The routing decision: the detailed Dev flow opens only when the host
 * actually injected one. A host without a Dev Runtime (web-only, cloud-only
 * contexts) keeps the basic dialog and stays truthful about what it can
 * create there.
 */
export function resolveCreateProjectSurface(
  flow: DevProjectFlow | undefined
): CreateProjectSurface {
  return flow ? 'detailed' : 'basic'
}

/**
 * Derives the flow from the host's Dev Runtime service. The flow exists only
 * while the runtime is ready and holds a bound scope — exactly the states
 * where the repository commands could succeed — so an unavailable or
 * unscoped runtime degrades to the basic dialog instead of opening a dialog
 * that cannot authorize anything.
 */
export function devProjectFlow(input: {
  runtime: DevRuntimeService
  renderDialog: DevProjectFlow['renderDialog']
  knownProjectNames: readonly string[]
  onCreateProject(name: string): Promise<string>
  pickFolder?: () => Promise<string | null | undefined>
}): DevProjectFlow | undefined {
  const runtime = input.runtime
  const scope = runtime.preferenceScope?.()
  if (!scope || runtime.state().status !== 'ready') return undefined
  return {
    scope,
    renderDialog: input.renderDialog,
    execute: (command) => runtime.execute(command),
    knownProjectNames: input.knownProjectNames,
    onCreateProject: input.onCreateProject,
    ...(input.pickFolder ? { pickFolder: input.pickFolder } : {}),
  }
}
