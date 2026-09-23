import {
  DECISION_RESOLUTION_CONTRACT_VERSION,
  type DecisionLayerResolution,
  type DecisionLayerClient,
  type DecisionLayerOutcome,
  type DecisionPins,
  type DecisionResolutionRequest,
  resolveDecisionLayer,
} from './decision-layer'

export * from './decision-layer'

export type ComposerMode = 'auto' | 'customize'

export type ComposerAgentProfile = Readonly<{
  id: string
  versionId?: string
  label: string
}>

export type ComposerPinOption = Readonly<{ id: string; label: string }>

export type ComposerCustomization = Readonly<{
  harnessOptions: readonly ComposerPinOption[]
  modelOptions: readonly ComposerPinOption[]
  /**
   * Registered execution locations the user may pin (#37/#186). Omitted when
   * the host knows no registered runtimes, in which case the composer simply
   * does not offer a location choice.
   */
  runtimeOptions?: readonly ComposerPinOption[]
  harnessId?: string
  modelId?: string
  runtimeDefinitionId?: string
  onHarnessChange?: (harnessId: string) => void
  onModelChange?: (modelId: string) => void
  onRuntimeChange?: (runtimeDefinitionId: string) => void
}>

export type ComposerPreferences = Readonly<{
  schemaVersion: 1
  accountId: string
  workspaceId: string
  projectId: string
  mode: ComposerMode
  agentProfileId?: string
  favorites: readonly string[]
  recents: readonly string[]
}>

export type ComposerPreferenceStore = Readonly<{
  read(key: string): string | undefined
  write(key: string, value: string): void
}>

export function composerPreferenceKey(scope: {
  accountId: string
  workspaceId: string
  projectId: string
}): string {
  return `adea.chat.composer.v1:${scope.accountId}:${scope.workspaceId}:${scope.projectId}`
}

/** Serialize only non-secret composer choices; credentials never enter this record. */
export function saveComposerPreferences(
  store: ComposerPreferenceStore,
  preferences: ComposerPreferences
): void {
  store.write(
    composerPreferenceKey(preferences),
    JSON.stringify({
      schemaVersion: 1,
      accountId: preferences.accountId,
      workspaceId: preferences.workspaceId,
      projectId: preferences.projectId,
      mode: preferences.mode,
      ...(preferences.agentProfileId ? { agentProfileId: preferences.agentProfileId } : {}),
      favorites: [...preferences.favorites],
      recents: [...preferences.recents],
    })
  )
}

export function loadComposerPreferences(
  store: ComposerPreferenceStore,
  scope: Pick<ComposerPreferences, 'accountId' | 'workspaceId' | 'projectId'>
): ComposerPreferences | undefined {
  const raw = store.read(composerPreferenceKey(scope))
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw) as Partial<ComposerPreferences>
    if (
      value.schemaVersion !== 1 ||
      value.accountId !== scope.accountId ||
      value.workspaceId !== scope.workspaceId ||
      value.projectId !== scope.projectId ||
      (value.mode !== 'auto' && value.mode !== 'customize') ||
      !Array.isArray(value.favorites) ||
      !Array.isArray(value.recents)
    )
      return undefined
    return {
      schemaVersion: 1,
      ...scope,
      mode: value.mode,
      ...(typeof value.agentProfileId === 'string' ? { agentProfileId: value.agentProfileId } : {}),
      favorites: value.favorites.filter((item): item is string => typeof item === 'string'),
      recents: value.recents.filter((item): item is string => typeof item === 'string'),
    }
  } catch {
    return undefined
  }
}

export type ComposerDecisionInputs = Omit<
  DecisionResolutionRequest,
  'contractVersion' | 'explicitPins'
> &
  Readonly<{
    mode: ComposerMode
    explicitPins?: DecisionPins
  }>

function hasPins(pins: DecisionPins | undefined): boolean {
  return pins !== undefined && Object.keys(pins).length > 0
}

/** Build the exact #558 request; Auto never accepts local selection pins. */
/**
 * Human label for the execution location a resolution selected (#37/#186). The
 * location policy decides *whether* a location may run; this is the surface
 * that shows the user which one actually did, so an execution never appears to
 * have run somewhere it did not.
 */
export function resolvedLocationLabel(resolution: DecisionLayerResolution): string {
  const { kind, transport } = resolution.resolution.runtime
  const where =
    kind === 'local'
      ? 'Local device'
      : kind === 'self-hosted'
        ? 'Self-hosted host'
        : 'Agent HQ Cloud'
  return transport === 'direct-local' ? `${where} · direct local` : `${where} · remote gateway`
}

export function buildComposerDecisionRequest(
  input: ComposerDecisionInputs
): DecisionResolutionRequest {
  if (input.objective.trim().length === 0) throw new Error('A launch objective is required.')
  if (input.mode === 'auto' && hasPins(input.explicitPins))
    throw new Error('Auto mode cannot carry explicit selection pins.')
  return {
    contractVersion: DECISION_RESOLUTION_CONTRACT_VERSION,
    caller: input.caller,
    requestId: input.requestId,
    workspaceId: input.workspaceId,
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    correlation: input.correlation,
    requestedAt: input.requestedAt,
    objective: input.objective.trim(),
    agentProfile: input.agentProfile,
    availableRuntimes: input.availableRuntimes,
    entitlements: input.entitlements,
    requiredCapabilities: input.requiredCapabilities,
    costLatencyPreference: input.costLatencyPreference,
    projectDefaults: input.projectDefaults,
    profileDefaults: input.profileDefaults,
    explicitPins: input.mode === 'customize' ? (input.explicitPins ?? {}) : {},
  }
}

export type ComposerDecisionConsumer = Readonly<{
  client: DecisionLayerClient
  /** The host performs the existing #400 create/launch transaction here. */
  onResolved: (
    resolution: DecisionLayerResolution,
    request: DecisionResolutionRequest
  ) => void | Promise<void>
  onOutcome?: (outcome: DecisionLayerOutcome) => void
}>

export async function resolveAndLaunchComposer(
  consumer: ComposerDecisionConsumer,
  request: DecisionResolutionRequest
): Promise<DecisionLayerOutcome> {
  const outcome = await resolveDecisionLayer(consumer.client, request)
  consumer.onOutcome?.(outcome)
  if (outcome.kind === 'resolved') await consumer.onResolved(outcome.resolution, request)
  return outcome
}
