// Pure model for the self-hosted connection setup and recovery surface (#188). No Solid, no
// network: the panel imports these and the unit suite exercises them directly.
//
// Every statement here is derived from an observation Adea actually holds: the registration
// record, the last accepted proof, and what the Control Plane discovery read reported. A
// missing or failed observation is reported as unknown, never as a healthy or unhealthy host.
// Execution-host registration and synchronized-history authority are different authorities;
// this model never lets one stand in for the other.
import type {
  ApiRuntimeConnection,
  ApiRuntimeNode,
  ApiRuntimeNodeConnectionsResponse,
} from '@adea-ai/api-client'
import type { ExecutionLocationRemediationAction } from '@adea-ai/types'

import {
  connectionFreshness,
  conservativeNodeProof,
  nodeProofState,
  runtimeStateLabel,
  type NodeProof,
} from './runtime-inventory-model'

/** The subset of the shared status tones this surface uses. */
export type FactTone = 'danger' | 'neutral' | 'success' | 'unknown' | 'warning'

export type DiagnosticId =
  | 'access'
  | 'capabilities'
  | 'compatibility'
  | 'discovery'
  | 'proof'
  | 'registration'

export type Diagnostic = Readonly<{
  id: DiagnosticId
  label: string
  tone: FactTone
  /** One word or phrase, safe to show as a status chip. */
  verdict: string
  /** What was observed, and what that does not tell us. */
  detail: string
  /** The execution-location policy's own remediation vocabulary. */
  action?: ExecutionLocationRemediationAction
}>

/** What the last Control Plane discovery read for one host produced. */
export type DiscoveryRead =
  | Readonly<{ state: 'not_read' }>
  | Readonly<{ state: 'loading' }>
  | Readonly<{ state: 'failed'; status?: number }>
  | Readonly<{ state: 'read'; page: ApiRuntimeNodeConnectionsResponse }>

export type HostInput = Readonly<{
  node: ApiRuntimeNode
  discovery: DiscoveryRead
  /** Capabilities the caller needs; none means no specific requirement. */
  requiredCapabilities?: readonly string[]
}>

const MAX_LIMITATIONS = 4
const MAX_LIMITATION_CHARS = 120

function boundedList(values: readonly string[]): string {
  return values
    .slice(0, MAX_LIMITATIONS)
    .map((value) => (value.length > MAX_LIMITATION_CHARS ? `${value.slice(0, 117)}…` : value))
    .join(' · ')
}

function connectionsOf(discovery: DiscoveryRead): readonly ApiRuntimeConnection[] {
  return discovery.state === 'read' && discovery.page.discovery.state === 'available'
    ? discovery.page.connections
    : []
}

/**
 * Either authoritative registration read can downgrade a host; neither can upgrade it. A
 * discovery page for a different registered identity is ignored rather than merged.
 */
export function effectiveNodeProof(input: HostInput, now: number): NodeProof {
  const own: NodeProof = input.node
  if (input.discovery.state !== 'read') return conservativeNodeProof(own, own, now)
  const other = input.discovery.page.node
  const sameIdentity =
    other.id === input.node.id &&
    other.controlPlaneRuntimeNodeRefId === input.node.controlPlaneRuntimeNodeRefId
  return sameIdentity
    ? conservativeNodeProof(own, other, now)
    : conservativeNodeProof(own, own, now)
}

const COMPAT_RANK: Readonly<Record<ApiRuntimeConnection['compatibility']['state'], number>> = {
  compatible: 0,
  degraded: 1,
  untested: 2,
  capability_missing: 3,
  deprecated: 4,
  unavailable: 5,
  incompatible: 6,
  revoked: 7,
}

function worstCompatibility(connections: readonly ApiRuntimeConnection[]) {
  return connections.reduce<ApiRuntimeConnection | undefined>(
    (worst, item) =>
      !worst || COMPAT_RANK[item.compatibility.state] > COMPAT_RANK[worst.compatibility.state]
        ? item
        : worst,
    undefined
  )
}

function versionFacts(node: ApiRuntimeNode, connection?: ApiRuntimeConnection): string {
  const parts = [`registered software ${node.softwareVersion}`]
  if (connection) {
    const { adapter, driver, harness, protocol } = connection.versions
    parts.push(`adapter ${adapter}`, `driver ${driver}`, `harness ${harness}`)
    if (protocol) parts.push(`protocol ${protocol}`)
  }
  return parts.join(' · ')
}

function registrationDiagnostic(input: HostInput, now: number): Diagnostic {
  const proof = effectiveNodeProof(input, now)
  if (proof.pairingState === 'revoked')
    return {
      id: 'registration',
      label: 'Execution registration',
      tone: 'danger',
      verdict: 'Revoked',
      detail:
        'Adea no longer sends execution commands to this host. A revoked identity cannot resume; register the host again to create a new identity.',
      action: 'repair_or_select_location',
    }
  return {
    id: 'registration',
    label: 'Execution registration',
    tone: 'success',
    verdict: 'Registered',
    detail:
      'This workspace holds a registration for the host. A registration records identity; it does not show the host is running or allowed to take work.',
  }
}

function proofDiagnostic(input: HostInput, now: number): Diagnostic {
  const proof = effectiveNodeProof(input, now)
  if (proof.pairingState === 'revoked')
    return {
      id: 'proof',
      label: 'Last proof from the host',
      tone: 'neutral',
      verdict: 'Not applicable',
      detail: 'Adea refuses proofs from a revoked identity, so liveness is not tracked.',
    }
  const state = nodeProofState(proof, now)
  if (state === 'Recent proof')
    return {
      id: 'proof',
      label: 'Last proof from the host',
      tone: 'success',
      verdict: 'Recent proof',
      detail:
        'The host proved possession of its key within the last five minutes. A proof shows liveness only; it does not authorize work.',
    }
  if (state === 'Stale proof')
    return {
      id: 'proof',
      label: 'Last proof from the host',
      tone: 'warning',
      verdict: 'Stale proof',
      detail:
        'Adea has not accepted a proof from this host for more than five minutes. Adea cannot tell whether the host is stopped, restarting or cannot reach Adea.',
      action: 'reconnect_location',
    }
  return {
    id: 'proof',
    label: 'Last proof from the host',
    tone: 'unknown',
    verdict: 'Proof unknown',
    detail: 'Adea has no usable proof time for this host, so its liveness is unknown.',
    action: 'refresh_location',
  }
}

function discoveryDiagnostic(input: HostInput, now: number): Diagnostic {
  const base = { id: 'discovery', label: 'Control Plane report' } as const
  const { discovery } = input
  if (discovery.state === 'not_read')
    return {
      ...base,
      tone: 'unknown',
      verdict: 'Not checked',
      detail: 'Run a check to read what the host’s Control Plane reports.',
      action: 'refresh_location',
    }
  if (discovery.state === 'loading')
    return {
      ...base,
      tone: 'unknown',
      verdict: 'Checking…',
      detail: 'Waiting for the Control Plane report.',
    }
  if (discovery.state === 'failed') {
    const status = discovery.status
    const reason =
      status === 401
        ? 'You are signed out, so the check could not run.'
        : status === 403
          ? 'Only workspace owners and admins can check execution hosts.'
          : status === 503
            ? 'Adea’s discovery service is unavailable.'
            : 'The check did not complete.'
    return {
      ...base,
      tone: 'unknown',
      verdict: 'Could not check',
      detail: `${reason} This says nothing about whether the host is running.`,
      action: 'refresh_location',
    }
  }
  const page = discovery.page
  if (page.discovery.state === 'unavailable')
    return {
      ...base,
      tone: 'unknown',
      verdict: 'No report received',
      detail:
        'The Control Plane did not return a report. The registration is retained, and this says nothing about whether the host is running.',
      action: 'refresh_location',
    }
  const connections = page.connections
  if (connections.length === 0)
    return {
      ...base,
      tone: 'warning',
      verdict: 'No runtimes reported',
      detail: 'The Control Plane answered and reported no runtimes for this host.',
      action: 'refresh_location',
    }
  const notFresh = connections.filter((item) => connectionFreshness(item, now) !== 'fresh')
  if (notFresh.length > 0)
    return {
      ...base,
      tone: 'warning',
      verdict: 'Report is out of date',
      detail: `${notFresh.length} of ${connections.length} reported runtimes are older than the five-minute window. Check again before relying on them.`,
      action: 'refresh_location',
    }
  return {
    ...base,
    tone: 'success',
    verdict: `${connections.length} runtime${connections.length === 1 ? '' : 's'} reported`,
    detail:
      'These are observations from the host’s Control Plane. Adea checks the host again when work is submitted.',
  }
}

function compatibilityDiagnostic(input: HostInput): Diagnostic {
  const base = { id: 'compatibility', label: 'Version compatibility' } as const
  const connections = connectionsOf(input.discovery)
  const worst = worstCompatibility(connections)
  if (!worst)
    return {
      ...base,
      tone: 'unknown',
      verdict: 'Not checked',
      detail: `Compatibility is only known once the Control Plane reports a runtime. Adea has ${versionFacts(input.node)}.`,
      action: 'refresh_location',
    }
  const facts = versionFacts(input.node, worst)
  const limitations = boundedList(worst.compatibility.limitations)
  const suffix = limitations ? ` Reported limitations: ${limitations}.` : ''
  const state = worst.compatibility.state
  switch (state) {
    case 'compatible':
      return {
        ...base,
        tone: 'success',
        verdict: 'Compatible',
        detail: `The Control Plane reports a compatible runtime (${facts}).${suffix}`,
      }
    case 'degraded':
    case 'untested':
      return {
        ...base,
        tone: 'warning',
        verdict: state === 'untested' ? 'Untested' : 'Degraded',
        detail: `The Control Plane reports this runtime as ${runtimeStateLabel(state)} (${facts}).${suffix}`,
      }
    case 'capability_missing':
      return {
        ...base,
        tone: 'danger',
        verdict: 'Capability missing',
        detail: `The host reports a runtime that lacks a required capability (${facts}).${suffix}`,
        action: 'enable_required_capabilities_or_select_location',
      }
    case 'deprecated':
      return {
        ...base,
        tone: 'warning',
        verdict: 'Update needed',
        detail: `The Control Plane marks this runtime deprecated (${facts}). Update the host’s Control Plane, then check again.${suffix}`,
        action: 'upgrade_or_select_compatible_location',
      }
    case 'incompatible':
    case 'unavailable':
    case 'revoked':
      return {
        ...base,
        tone: 'danger',
        verdict: state === 'incompatible' ? 'Incompatible' : runtimeStateLabel(state),
        detail: `The Control Plane reports this runtime as ${runtimeStateLabel(state)} (${facts}). Update the host’s Control Plane, then check again. Adea does not publish a minimum version number here, so the reported state is the evidence.${suffix}`,
        action: 'upgrade_or_select_compatible_location',
      }
  }
}

/** Capabilities a connection supports, by what its own report says. */
export function supportedCapabilities(connection: ApiRuntimeConnection): readonly string[] {
  const details = connection.capabilityDetails
  if (details.length === 0) return connection.capabilities
  return details.filter((item) => item.support === 'supported').map((item) => item.name)
}

export function missingCapabilities(
  connection: ApiRuntimeConnection,
  required: readonly string[]
): readonly string[] {
  const supported = new Set(supportedCapabilities(connection))
  return [...new Set(required.filter((name) => !supported.has(name)))].toSorted()
}

/** Capability limitations stated as the report states them, one line per capability. */
export function unavailableCapabilityFacts(connection: ApiRuntimeConnection): readonly string[] {
  return connection.capabilityDetails
    .filter((item) => item.support !== 'supported')
    .map((item) => {
      const limits = item.limitations?.length ? ` — ${boundedList(item.limitations)}` : ''
      return `${item.name}: reported ${item.support}${limits}`
    })
}

function capabilitiesDiagnostic(input: HostInput): Diagnostic {
  const base = { id: 'capabilities', label: 'Capabilities' } as const
  const connections = connectionsOf(input.discovery)
  if (connections.length === 0)
    return {
      ...base,
      tone: 'unknown',
      verdict: 'Not reported',
      detail: 'No runtime has reported capabilities for this host, so none can be confirmed.',
    }
  const required = input.requiredCapabilities ?? []
  const gaps = connections.map((item) => missingCapabilities(item, required))
  const best = gaps.reduce((a, b) => (b.length < a.length ? b : a))
  if (required.length > 0 && best.length > 0)
    return {
      ...base,
      tone: 'danger',
      verdict: 'Missing capabilities',
      detail: `No reported runtime supports ${best.join(', ')}. This is based on what each runtime reported, not on a test run.`,
      action: 'enable_required_capabilities_or_select_location',
    }
  const gapFacts = connections.flatMap(unavailableCapabilityFacts)
  if (gapFacts.length > 0)
    return {
      ...base,
      tone: 'warning',
      verdict: 'Some limited',
      detail: `Reported limits: ${boundedList(gapFacts)}.`,
    }
  return {
    ...base,
    tone: 'success',
    verdict: required.length > 0 ? 'Required capabilities reported' : 'Reported',
    detail:
      required.length > 0
        ? 'A reported runtime lists every required capability. Support is checked again at submission.'
        : 'Runtimes listed their capabilities. No specific capability was required for this check.',
  }
}

function accessDiagnostic(input: HostInput): Diagnostic {
  const base = { id: 'access', label: 'Project access and entitlement' } as const
  const connections = connectionsOf(input.discovery)
  if (connections.length === 0)
    return {
      ...base,
      tone: 'unknown',
      verdict: 'Not reported',
      detail: 'Grants and entitlement are reported per runtime; none has reported yet.',
    }
  const problems = new Set<string>()
  for (const item of connections) {
    const grant = item.access.localProjectGrant
    if (grant.required && grant.state !== 'granted')
      problems.add(`project grant ${runtimeStateLabel(grant.state)}`)
    if (item.access.entitlement.state === 'denied') problems.add('entitlement denied')
    if (item.access.entitlement.state === 'unknown') problems.add('entitlement unknown')
  }
  if (problems.size === 0)
    return {
      ...base,
      tone: 'success',
      verdict: 'Reported allowed',
      detail:
        'Runtimes report no missing project grant and an allowed entitlement. Registration and a recent proof are not permission to run; this is the host’s own report.',
    }
  const hardProblem = [...problems].some((item) => !item.endsWith('unknown'))
  return {
    ...base,
    tone: hardProblem ? 'danger' : 'unknown',
    verdict: hardProblem ? 'Restricted' : 'Unknown',
    detail: `Reported: ${[...problems].join(' · ')}.`,
    action: hardProblem ? 'repair_or_select_location' : 'refresh_location',
  }
}

const NOT_APPLICABLE: Readonly<
  Record<'access' | 'capabilities' | 'compatibility' | 'discovery', string>
> = {
  access: 'Project access and entitlement',
  capabilities: 'Capabilities',
  compatibility: 'Version compatibility',
  discovery: 'Control Plane report',
}

/** The full ordered set of facts behind a host’s status, each with what it does not prove. */
export function diagnoseHost(input: HostInput, now: number): readonly Diagnostic[] {
  const registration = registrationDiagnostic(input, now)
  const proof = proofDiagnostic(input, now)
  if (registration.tone === 'danger')
    // A revoked host is not asked about work, so its reports say nothing that matters.
    return [
      registration,
      proof,
      ...(Object.entries(NOT_APPLICABLE) as [keyof typeof NOT_APPLICABLE, string][]).map(
        ([id, label]): Diagnostic => ({
          id,
          label,
          tone: 'neutral',
          verdict: 'Not applicable',
          detail: 'Adea does not send work to a revoked host, so this is not checked.',
        })
      ),
    ]
  return [
    registration,
    proof,
    discoveryDiagnostic(input, now),
    compatibilityDiagnostic(input),
    capabilitiesDiagnostic(input),
    accessDiagnostic(input),
  ]
}

export type HostHeadline = Readonly<{ label: string; tone: FactTone }>

/**
 * One chip for a list row. It is the worst observation, so a host is never summarized as
 * better than its weakest fact; `Reported eligible` is a report, not a clearance to run work.
 */
export function hostHeadline(input: HostInput, now: number): HostHeadline {
  const diagnostics = diagnoseHost(input, now)
  const byId = (id: DiagnosticId) => diagnostics.find((item) => item.id === id)!
  if (byId('registration').tone === 'danger') return { label: 'Revoked', tone: 'danger' }
  const compat = byId('compatibility')
  if (compat.tone === 'danger') return { label: compat.verdict, tone: 'danger' }
  for (const id of ['access', 'capabilities'] as const) {
    const item = byId(id)
    if (item.tone === 'danger') return { label: item.verdict, tone: 'danger' }
  }
  const proof = byId('proof')
  if (proof.tone !== 'success') return { label: proof.verdict, tone: proof.tone }
  const discovery = byId('discovery')
  if (discovery.tone !== 'success') return { label: discovery.verdict, tone: discovery.tone }
  if (compat.tone === 'warning') return { label: compat.verdict, tone: 'warning' }
  const eligible = connectionsOf(input.discovery).some(
    (item) => item.eligibility.state !== 'ineligible'
  )
  return eligible
    ? { label: 'Reported eligible', tone: 'success' }
    : { label: 'Reported ineligible', tone: 'warning' }
}

export type Selectability = Readonly<{ allowed: boolean; blockers: readonly string[] }>

/**
 * A host can be chosen only when every check Adea can make passes. Choosing a host is a
 * preference for where work should run; it never bypasses the admission check at submission.
 */
export function hostSelectability(input: HostInput, now: number): Selectability {
  const blockers: string[] = []
  for (const item of diagnoseHost(input, now)) {
    if (item.id === 'capabilities' || item.id === 'access') {
      if (item.tone === 'danger' || item.tone === 'unknown')
        blockers.push(`${item.label}: ${item.verdict}`)
      continue
    }
    if (item.tone !== 'success') blockers.push(`${item.label}: ${item.verdict}`)
  }
  const connections = connectionsOf(input.discovery)
  if (
    connections.length > 0 &&
    !connections.some(
      (item) =>
        connectionFreshness(item, now) === 'fresh' &&
        item.eligibility.state !== 'ineligible' &&
        (item.compatibility.state === 'compatible' || item.compatibility.state === 'degraded') &&
        missingCapabilities(item, input.requiredCapabilities ?? []).length === 0
    )
  )
    blockers.push('No single reported runtime passes every check')
  return { allowed: blockers.length === 0, blockers: [...new Set(blockers)] }
}

const REMEDIATION_COPY: Readonly<Record<ExecutionLocationRemediationAction, string>> = {
  select_registered_location: 'Choose one of the registered hosts.',
  reconnect_location:
    'Start or restart the host’s registration agent and make sure it can reach Adea, then check again.',
  refresh_location: 'Check again to read current observations.',
  repair_or_select_location:
    'Register the host again to create a new identity, or choose a different host.',
  upgrade_or_select_compatible_location:
    'Update the host’s Control Plane to a compatible release, then check again, or choose a different host.',
  enable_required_capabilities_or_select_location:
    'Enable the missing capabilities on the host, then check again, or choose a different host.',
  enable_cloud_feature: 'Enable the cloud location in workspace settings.',
}

export function remediationCopy(action: ExecutionLocationRemediationAction): string {
  return REMEDIATION_COPY[action]
}

/** Distinct next steps, in the order the checks run, without repeats. */
export function remediationSteps(diagnostics: readonly Diagnostic[]): readonly string[] {
  const actions = diagnostics.flatMap((item) => (item.action ? [item.action] : []))
  return [...new Set(actions)].map(remediationCopy)
}

// ---------------------------------------------------------------------------------------------
// Authorities. Execution and synchronized history are separate; the second is not reported by
// any contract Adea currently exposes, so it is shown as unknown rather than inferred.

export type AuthorityPanel = Readonly<{
  id: 'execution' | 'history'
  title: string
  tone: FactTone
  verdict: string
  summary: string
  facts: readonly Readonly<{ label: string; value: string }>[]
  /** What this authority does not decide. */
  boundaries: readonly string[]
}>

export function executionAuthority(input: HostInput, now: number): AuthorityPanel {
  const registration = registrationDiagnostic(input, now)
  const proof = proofDiagnostic(input, now)
  return {
    id: 'execution',
    title: 'Execution host',
    tone:
      registration.tone === 'danger' ? 'danger' : proof.tone === 'success' ? 'success' : proof.tone,
    verdict: registration.tone === 'danger' ? 'Revoked' : `Registered · ${proof.verdict}`,
    summary:
      'Whether Adea may send this host execution commands, and whether the host has recently proved it is alive.',
    facts: [
      { label: 'Registration', value: registration.verdict },
      { label: 'Last proof', value: proof.verdict },
      { label: 'Software', value: `${input.node.platform} · ${input.node.softwareVersion}` },
    ],
    boundaries: [
      'Does not decide who can read synchronized history.',
      'Does not hold or reveal the host’s private keys, provider keys or data.',
    ],
  }
}

/**
 * Synchronized-history authority is governed by member and device policy (#193), not by the
 * execution registration. Adea does not currently report a history-sync identity for a host, so
 * the honest state is unknown, and it is the same whatever the execution state is.
 */
export function historyAuthority(): AuthorityPanel {
  return {
    id: 'history',
    title: 'Synchronized history',
    tone: 'unknown',
    verdict: 'Not reported for this host',
    summary:
      'Whether this host holds a separate identity for synchronizing private conversation history.',
    facts: [
      { label: 'History-sync identity', value: 'Not reported' },
      { label: 'Effect of host connection', value: 'None. This view never hides history' },
    ],
    boundaries: [
      'Registering this host does not grant history decryption.',
      'Revoking or losing this host does not revoke history access held by authorized devices.',
    ],
  }
}

/** What revoking execution does and does not do. The list is shown before the action. */
export const REVOCATION_EFFECTS = {
  does: [
    'Adea stops sending new execution commands to this host.',
    'The host’s identity stays on record as revoked. It cannot resume.',
  ],
  doesNot: [
    'It does not delete anything on the host or its data.',
    'It does not erase records Adea holds about past work.',
    'It does not change who can read synchronized history.',
    'It does not cancel work the host has already accepted.',
  ],
} as const

// ---------------------------------------------------------------------------------------------
// Failures

export type FailureKind =
  | 'credential_rejected'
  | 'endpoint'
  | 'expired'
  | 'forbidden'
  | 'invalid'
  | 'replayed'
  | 'revoked_identity'
  | 'signed_out'
  | 'stale_state'
  | 'unknown'

export type FailureRetry = 'new_pairing' | 'refresh' | 'same' | 'sign_in' | 'switch_account'

export type FailureGuidance = Readonly<{
  kind: FailureKind
  title: string
  guidance: string
  retry: FailureRetry
}>

export type FailureContext = 'pairing' | 'read' | 'rename' | 'revoke'

function failureSignal(error: unknown): { status?: number; code?: string } {
  if (typeof error !== 'object' || error === null) return {}
  const record = error as Record<string, unknown>
  return {
    ...(typeof record.status === 'number' ? { status: record.status } : {}),
    ...(typeof record.code === 'string' ? { code: record.code } : {}),
  }
}

/**
 * Stable machine codes only: a server message is never shown, because it may carry detail the
 * reader should not see. An unknown code is reported as unknown.
 */
export function classifyFailure(error: unknown, context: FailureContext): FailureGuidance {
  const { status, code } = failureSignal(error)
  if (status === 401)
    return {
      kind: 'signed_out',
      title: 'You are signed out',
      guidance: 'Sign in again. What you typed is kept, and nothing was changed.',
      retry: 'sign_in',
    }
  switch (code) {
    case 'challenge_expired':
      return {
        kind: 'expired',
        title: 'The pairing expired',
        guidance:
          'A pairing is good for ten minutes and for one registration. Create a new pairing and give the host the new values.',
        retry: 'new_pairing',
      }
    case 'challenge_used':
      return {
        kind: 'replayed',
        title: 'The pairing was already used',
        guidance:
          'A pairing works once, so a repeated or replayed registration is refused. If a host registered, it is listed below; otherwise create a new pairing.',
        retry: 'new_pairing',
      }
    case 'exchange_credential_invalid':
      return {
        kind: 'credential_rejected',
        title: 'The registration credential was not accepted',
        guidance:
          'The credential was already spent, has expired, or belongs to a different pairing. Create a new pairing and use all of its values together.',
        retry: 'new_pairing',
      }
    case 'revoked':
      return context === 'revoke'
        ? {
            kind: 'stale_state',
            title: 'The host was already revoked',
            guidance: 'Someone revoked it before this request. The list is being refreshed.',
            retry: 'refresh',
          }
        : {
            kind: 'revoked_identity',
            title: 'That host identity was revoked',
            guidance:
              'A revoked identity cannot resume. Register the host again to create a new identity.',
            retry: 'new_pairing',
          }
    case 'not_found':
      return {
        kind: 'stale_state',
        title: 'That host is no longer in this workspace',
        guidance:
          'It was removed, or this view belongs to another workspace. The list is being refreshed.',
        retry: 'refresh',
      }
    case 'unauthorized':
      return forbidden()
    case 'key_mismatch':
    case 'invalid':
      return {
        kind: 'invalid',
        title: 'The request was not valid',
        guidance:
          context === 'pairing'
            ? 'The host presented values that do not match this pairing. Create a new pairing and copy every value without edits.'
            : 'Check what you entered and try again. Your input is kept.',
        retry: 'same',
      }
    default:
  }
  if (status === 403 || status === 404) return forbidden()
  if (status === 409)
    return {
      kind: 'stale_state',
      title: 'The host changed since this view loaded',
      guidance:
        'Its state was updated elsewhere. The list is being refreshed; review it and retry.',
      retry: 'refresh',
    }
  if (status === undefined || status === 0 || status >= 500)
    return {
      kind: 'endpoint',
      title:
        status === undefined || status === 0 ? 'Adea could not be reached' : 'Adea had a problem',
      guidance:
        'Nothing was changed that this view can confirm. Check your connection and try again; what you typed is kept.',
      retry: 'same',
    }
  return {
    kind: 'unknown',
    title: 'The request did not complete',
    guidance: 'The cause is not known. Refresh the list to see the current state.',
    retry: 'refresh',
  }
}

function forbidden(): FailureGuidance {
  return {
    kind: 'forbidden',
    title: 'This account cannot do that here',
    guidance:
      'Only an owner or admin of this workspace can manage execution hosts, and a pairing only works in the workspace and account that created it. Check which account and workspace you are in.',
    retry: 'switch_account',
  }
}

// ---------------------------------------------------------------------------------------------
// Pairing

/** What opening a pairing returned. The credential is secret and is held in memory only. */
export type PairingGrant = Readonly<{
  challengeId: string
  nonce: string
  exchangeCredential: string
  expiresAt: string
}>

export type PairingScope = Readonly<{ accountId: string; workspaceId: string }>

export type PairingState = 'active' | 'consumed' | 'discarded' | 'expired'

export function sameScope(left: PairingScope, right: PairingScope): boolean {
  return left.accountId === right.accountId && left.workspaceId === right.workspaceId
}

/**
 * Where a pairing stands. A pairing from another account or workspace is discarded, an
 * expired one is dead whatever else happened, and a new host appearing after it was issued is
 * treated as consumed because a pairing registers at most one host.
 */
export function pairingState(
  grant: Readonly<{ expiresAt: string; issuedAt: number; scope: PairingScope }>,
  current: Readonly<{
    hostIds: readonly string[]
    hostIdsAtIssue: readonly string[]
    scope: PairingScope
  }>,
  now: number
): PairingState {
  if (!sameScope(grant.scope, current.scope)) return 'discarded'
  const expires = Date.parse(grant.expiresAt)
  if (!Number.isFinite(expires) || now >= expires) return 'expired'
  const before = new Set(current.hostIdsAtIssue)
  return current.hostIds.some((id) => !before.has(id)) ? 'consumed' : 'active'
}

export function pairingRemaining(expiresAt: string, now: number): string {
  const remaining = Date.parse(expiresAt) - now
  if (!Number.isFinite(remaining) || remaining <= 0) return 'Expired'
  const minutes = Math.floor(remaining / 60_000)
  const seconds = Math.floor((remaining % 60_000) / 1_000)
  return `${minutes}:${String(seconds).padStart(2, '0')} left`
}

// ---------------------------------------------------------------------------------------------
// Rename and revoke drafts

const MAX_NAME = 120
const MAX_REASON = 200

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

/** A problem string, or undefined when the name is acceptable. Mirrors the server bounds. */
export function hostNameProblem(
  draft: string,
  hosts: readonly Pick<ApiRuntimeNode, 'displayName' | 'id'>[],
  currentId: string
): string | undefined {
  const name = draft.trim()
  if (name.length === 0) return 'Enter a name.'
  if (name.length > MAX_NAME) return `Use ${MAX_NAME} characters or fewer.`
  if (hasControlCharacter(name)) return 'Remove control characters.'
  const clash = hosts.some(
    (host) => host.id !== currentId && host.displayName.trim().toLowerCase() === name.toLowerCase()
  )
  return clash ? 'Another host already uses that name. Hosts must stay distinct.' : undefined
}

export function revokeReasonProblem(draft: string): string | undefined {
  const reason = draft.trim()
  if (reason.length === 0) return 'Enter a reason. It is kept in the audit record.'
  if (reason.length > MAX_REASON) return `Use ${MAX_REASON} characters or fewer.`
  if (hasControlCharacter(reason)) return 'Remove control characters.'
  return undefined
}

/**
 * After a revoke succeeded, the list read decides what is true. A host the read still shows as
 * paired is reported as unconfirmed, not revoked, so a lost or reordered write is not hidden.
 */
export type RevocationOutcome = 'confirmed' | 'not_confirmed' | 'pending' | 'host_missing'

export function revocationOutcome(
  accepted: boolean,
  read: Pick<ApiRuntimeNode, 'pairingState'> | undefined,
  readAfterAccept: boolean
): RevocationOutcome {
  if (!accepted || !readAfterAccept) return 'pending'
  if (!read) return 'host_missing'
  return read.pairingState === 'revoked' ? 'confirmed' : 'not_confirmed'
}

/** Short, stable text that tells similarly named hosts apart without exposing any endpoint. */
export function hostIdentityLabel(node: ApiRuntimeNode): string {
  const ref = node.controlPlaneRuntimeNodeRefId
  return `${node.platform} · ${node.softwareVersion} · ref …${ref.slice(-6)}`
}
