// Browser lane registry (ADR 0006): three lane kinds with separate profile
// and process identities. Lane and profile IDs are immutable; the generation
// increments on every ownership transfer so input granted under an old
// generation is inert. Profile identity is derived from the full authority
// scope plus the lane kind — a human lane and an agent lane can never derive
// the same profile, and no lane can derive another scope's profile.
// Lifecycle and ownership rules follow the Dev Runtime spec's
// "Browser and device lanes"; the identity digest structure follows Orca's
// browser-route-identity (MIT, revision 403b62a8d8fa6e896a93acc4c15405be0f0b7dc7).
import { createHash, randomUUID } from 'node:crypto'

import type {
  BrowserLane,
  ProfilePolicy,
  Scope,
} from '../../../../../../packages/types/src/dev-runtime'
export type LaneKind = BrowserLane['kind']
export type AutomationOwner = BrowserLane['automationOwner']
export type LaneState = BrowserLane['state']

export type LaneViewport = Readonly<{
  width: number
  height: number
  deviceScaleFactor: number
  mobile: boolean
}>

export type BrowserLaneRecord = BrowserLane &
  Readonly<{
    createdAt: string
    profilePolicyId: string
    recording: boolean
    viewport: LaneViewport
    /** Owner-only profile directory label; never leaves the host. */
    profileDirectory: string
  }>

export class BrowserLaneError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'BrowserLaneError'
    this.code = code
  }
}

const PROFILE_IDENTITY_VERSION = 1
const VIEWPORT_MAX = 4096
const DEVICE_SCALE_MAX = 4

/** The lane permissions a policy may name; anything else is refused at mint. */
export const lanePermissions = [
  'downloads',
  'uploads',
  'clipboard',
  'camera',
  'microphone',
  'geolocation',
  'notifications',
  'popups',
  'certificate_exceptions',
] as const
export type LanePermission = (typeof lanePermissions)[number]

/**
 * Default policies are deny-by-default per lane kind (spec: navigation
 * permissions "are lane-specific and default denied where not required").
 * Only the preview lane needs notifications off and nothing grants clipboard,
 * camera, microphone, geolocation, popups, or certificate exceptions.
 */
const DEFAULT_POLICIES: Readonly<Record<LaneKind, readonly LanePermission[]>> = Object.freeze({
  human_embedded: [],
  task_owned: [],
  user_context: [],
})

function digest(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex')
}

/**
 * Derives the immutable profile identity for one lane. Different kinds never
 * collide (the kind is inside the digest), and neither do different scopes or
 * sessions — the property that keeps human cookies out of agent contexts.
 */
export function deriveLaneProfileId(
  scope: Scope,
  runtimeSessionId: string,
  kind: LaneKind
): string {
  for (const value of [scope.accountId, scope.workspaceId, scope.runtimeNodeId, runtimeSessionId]) {
    if (typeof value !== 'string' || value.length === 0)
      throw new BrowserLaneError('identity_mismatch', 'lane scope is incomplete')
  }
  return `adea-browser-profile-v${PROFILE_IDENTITY_VERSION}-${digest([
    'adea-browser-lane-profile',
    PROFILE_IDENTITY_VERSION,
    ['account', scope.accountId],
    ['workspace', scope.workspaceId],
    ['node', scope.runtimeNodeId],
    ['session', runtimeSessionId],
    ['kind', kind],
  ]).slice(0, 64)}`
}

export function isLanePermission(value: string): value is LanePermission {
  return (lanePermissions as readonly string[]).includes(value)
}

export type CreateLaneInput = Readonly<{
  scope: Scope
  runtimeSessionId: string
  kind: LaneKind
  profilePolicyId?: string
  initialUrl?: string
}>

export type BrowserLaneRegistryOptions = Readonly<{
  now?: () => string
  randomId?: () => string
}>

export function createBrowserLaneRegistry(options: BrowserLaneRegistryOptions = {}) {
  const now = options.now ?? (() => new Date().toISOString())
  const randomId = options.randomId ?? (() => randomUUID())
  const lanes = new Map<string, BrowserLaneRecord>()
  const baseOwnerByKind: Readonly<Record<LaneKind, AutomationOwner>> = Object.freeze({
    human_embedded: 'none',
    task_owned: 'agent',
    user_context: 'agent',
  })

  function lane(id: string): BrowserLaneRecord {
    const record = lanes.get(id)
    if (!record) throw new BrowserLaneError('not_found', `browser lane ${id} is unknown`)
    return record
  }

  function assertGeneration(record: BrowserLaneRecord, expectedGeneration: number): void {
    if (!Number.isSafeInteger(expectedGeneration))
      throw new BrowserLaneError('stale_generation', 'expected generation must be an integer')
    if (record.generation !== expectedGeneration)
      throw new BrowserLaneError(
        'stale_generation',
        `lane generation moved to ${record.generation}`
      )
  }

  const policies = new Map<string, ProfilePolicy>()

  // Defaults are deny-by-default and scope-free: any lane may select them and
  // they grant nothing.
  for (const kind of ['human_embedded', 'task_owned', 'user_context'] as const) {
    policies.set(`default:${kind}`, {
      id: `default:${kind}`,
      scope: {
        accountId: '00000000-0000-4000-8000-000000000000',
        workspaceId: '00000000-0000-4000-8000-000000000000',
        runtimeNodeId: '00000000-0000-4000-8000-000000000000',
      },
      label: `default-${kind.replaceAll('_', '-')}`,
      allowedPermissions: [...DEFAULT_POLICIES[kind]],
      version: 1,
    })
  }

  function policyAllowed(record: BrowserLaneRecord, permission: LanePermission): boolean {
    const policy = policies.get(record.profilePolicyId)
    if (!policy) return false
    return policy.allowedPermissions.includes(permission)
  }

  const registry = {
    policy(id: string): ProfilePolicy | undefined {
      return policies.get(id)
    },
    profilePolicies(): readonly ProfilePolicy[] {
      return [...policies.values()].toSorted((left, right) => left.id.localeCompare(right.id))
    },
    assertLanePermission(record: BrowserLaneRecord, permission: LanePermission): void {
      if (!policyAllowed(record, permission))
        throw new BrowserLaneError(
          'permission_denied',
          `lane policy denies ${permission}; permissions are default denied`
        )
    },
    lanePermissionsOf(record: BrowserLaneRecord): readonly string[] {
      return policies.get(record.profilePolicyId)?.allowedPermissions ?? []
    },

    create(input: CreateLaneInput): BrowserLaneRecord {
      if (!input.runtimeSessionId || input.runtimeSessionId.length > 256)
        throw new BrowserLaneError('identity_mismatch', 'runtime session id is required')
      const policyId = input.profilePolicyId ?? `default:${input.kind}`
      const policy = policies.get(policyId)
      if (!policy)
        throw new BrowserLaneError('profile_scope_denied', `profile policy ${policyId} is unknown`)
      // A non-default policy is bound to its minting scope; a lane in one
      // scope can never adopt another scope's permission policy.
      if (
        policyId.startsWith('default:') === false &&
        (policy.scope.accountId !== input.scope.accountId ||
          policy.scope.workspaceId !== input.scope.workspaceId ||
          policy.scope.runtimeNodeId !== input.scope.runtimeNodeId)
      )
        throw new BrowserLaneError('profile_scope_denied', 'policy belongs to another scope')
      const profileId = deriveLaneProfileId(input.scope, input.runtimeSessionId, input.kind)
      const record: BrowserLaneRecord = {
        id: randomId(),
        scope: { ...input.scope },
        runtimeSessionId: input.runtimeSessionId,
        kind: input.kind,
        profileId,
        state: 'provisioning',
        automationOwner: baseOwnerByKind[input.kind],
        generation: 1,
        createdAt: now(),
        profilePolicyId: policyId,
        recording: false,
        viewport: { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false },
        profileDirectory: profileId,
      }
      lanes.set(record.id, record)
      return record
    },

    /**
     * Readies a lane from every legitimate source state: `provisioning`
     * (first engine bind), `navigating` (a navigation completed), and
     * `recovering` (crash recovery finished). Nothing else may claim ready.
     */
    markReady(id: string): BrowserLaneRecord {
      const record = lane(id)
      if (
        record.state !== 'provisioning' &&
        record.state !== 'navigating' &&
        record.state !== 'recovering'
      )
        throw new BrowserLaneError('invalid_state', `lane is ${record.state}, not readyable`)
      return save({ ...record, state: 'ready' })
    },

    get: lane,

    list(
      filter: Readonly<{
        scope?: Scope
        runtimeSessionId?: string
        kind?: LaneKind
        state?: LaneState
      }> = {},
      page: Readonly<{ cursor?: string; limit?: number }> = {}
    ): { items: readonly BrowserLaneRecord[]; nextCursor?: string } {
      const limit = Math.min(Math.max(page.limit ?? 100, 1), 500)
      const offset = page.cursor ? Number.parseInt(page.cursor, 10) || 0 : 0
      const all = [...lanes.values()]
        .filter(
          (record) =>
            (filter.scope === undefined ||
              (record.scope.accountId === filter.scope.accountId &&
                record.scope.workspaceId === filter.scope.workspaceId &&
                record.scope.runtimeNodeId === filter.scope.runtimeNodeId)) &&
            (filter.runtimeSessionId === undefined ||
              record.runtimeSessionId === filter.runtimeSessionId) &&
            (filter.kind === undefined || record.kind === filter.kind) &&
            (filter.state === undefined || record.state === filter.state)
        )
        .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
      const items = all.slice(offset, offset + limit)
      const nextCursor = offset + limit < all.length ? String(offset + limit) : undefined
      return { items, nextCursor }
    },

    /**
     * Enters the navigating state. Only `ready`, `provisioning` (a lane's
     * first navigation completes provisioning), and `recovering` may
     * navigate; a crashed lane recovers through this transition
     * (crashed → recovering → navigating), so an engine fault never strands
     * the lane. Suspended lanes must release takeover first; concurrent and
     * closed lanes refuse.
     */
    navigate(id: string): BrowserLaneRecord {
      const record = lane(id)
      if (record.state === 'suspended')
        throw new BrowserLaneError(
          'invalid_state',
          'lane is suspended under human takeover; release it before navigating'
        )
      if (record.state === 'navigating')
        throw new BrowserLaneError('invalid_state', 'lane is already navigating')
      if (record.state === 'closing' || record.state === 'closed')
        throw new BrowserLaneError('invalid_state', 'lane is closed')
      if (record.state === 'crashed') return save({ ...record, state: 'recovering' })
      return save({ ...record, state: 'navigating' })
    },

    /** Explicit crashed → recovering entry; navigating also recovers. */
    markRecovering(id: string): BrowserLaneRecord {
      const record = lane(id)
      if (record.state !== 'crashed' && record.state !== 'recovering')
        throw new BrowserLaneError('invalid_state', `lane is ${record.state}, not crashed`)
      return save({ ...record, state: 'recovering' })
    },

    /**
     * Rolls a transient navigating state back so a failed or unavailable
     * navigation leaves the lane usable. A provisioning lane stays
     * provisioning (it may navigate again); navigating returns to ready.
     */
    markIdle(id: string): BrowserLaneRecord {
      const record = lane(id)
      if (record.state === 'navigating') return save({ ...record, state: 'ready' })
      return record
    },

    markCrashed(id: string): BrowserLaneRecord {
      const record = lane(id)
      // A closed lane is terminal; a crash report must not resurrect state.
      if (record.state === 'closed' || record.state === 'closing') return record
      return save({ ...record, state: 'crashed', automationOwner: 'none' })
    },

    setRecording(id: string, recording: boolean): BrowserLaneRecord {
      const record = lane(id)
      return save({ ...record, recording })
    },

    viewport(id: string, expectedGeneration: number, viewport: LaneViewport): BrowserLaneRecord {
      const record = lane(id)
      assertGeneration(record, expectedGeneration)
      const { width, height, deviceScaleFactor, mobile } = viewport
      if (
        !Number.isInteger(width) ||
        width < 1 ||
        width > VIEWPORT_MAX ||
        !Number.isInteger(height) ||
        height < 1 ||
        height > VIEWPORT_MAX
      )
        throw new BrowserLaneError('limit_exceeded', 'viewport exceeds 4096×4096')
      if (
        typeof deviceScaleFactor !== 'number' ||
        !Number.isFinite(deviceScaleFactor) ||
        deviceScaleFactor < 0.25 ||
        deviceScaleFactor > DEVICE_SCALE_MAX
      )
        throw new BrowserLaneError('limit_exceeded', 'device scale factor is out of range')
      return save({ ...record, viewport: { width, height, deviceScaleFactor, mobile } })
    },

    /**
     * Human takeover: suspends agent input and bumps the generation so every
     * grant minted before the takeover is inert.
     */
    takeover(id: string, expectedGeneration: number): BrowserLaneRecord {
      const record = lane(id)
      assertGeneration(record, expectedGeneration)
      if (record.automationOwner === 'human_takeover')
        throw new BrowserLaneError('invalid_state', 'lane is already under human takeover')
      return save({
        ...record,
        automationOwner: 'human_takeover',
        generation: record.generation + 1,
        state: record.state === 'crashed' ? record.state : 'suspended',
      })
    },

    /** Releases human capture back to the lane's base owner; Escape path. */
    release(id: string, expectedGeneration: number): BrowserLaneRecord {
      const record = lane(id)
      assertGeneration(record, expectedGeneration)
      if (record.automationOwner !== 'human_takeover')
        throw new BrowserLaneError('invalid_state', 'lane is not under human takeover')
      return save({
        ...record,
        automationOwner: baseOwnerByKind[record.kind],
        generation: record.generation + 1,
        state: record.state === 'suspended' ? 'ready' : record.state,
      })
    },

    /**
     * Decides whether one input event may reach the lane. Input granted under
     * an old generation is inert; `none` rejects all input; a task-owned lane
     * accepts input only within the owning task's grant.
     */
    admitInput(
      record: BrowserLaneRecord,
      input: Readonly<{
        principal: 'human' | 'agent' | 'task'
        taskGrantId?: string
        generation: number
      }>
    ): void {
      assertGeneration(record, input.generation)
      if (record.automationOwner === 'none')
        throw new BrowserLaneError('permission_denied', 'lane accepts no automation input')
      if (record.automationOwner === 'human_takeover') {
        if (input.principal !== 'human')
          throw new BrowserLaneError(
            'permission_denied',
            'agent input is suspended during human takeover'
          )
        return
      }
      if (record.kind === 'task_owned') {
        if (input.principal !== 'task' || !input.taskGrantId)
          throw new BrowserLaneError(
            'permission_denied',
            'task-owned lanes accept input only within the owning task grant'
          )
        if (input.taskGrantId !== record.runtimeSessionId)
          throw new BrowserLaneError(
            'profile_scope_denied',
            'task grant belongs to another session'
          )
        return
      }
      if (input.principal !== 'agent')
        throw new BrowserLaneError('permission_denied', 'external lanes accept only agent input')
    },

    /**
     * Atomic profile reset: wipes only this lane's derived profile directory
     * identity. It can never address the user's normal browser profile
     * because that profile has no derived lane identity.
     */
    profileReset(
      id: string,
      expectedGeneration: number,
      confirmationId: string
    ): BrowserLaneRecord {
      const record = lane(id)
      assertGeneration(record, expectedGeneration)
      if (!confirmationId)
        throw new BrowserLaneError('permission_denied', 'reset requires confirmation')
      return save({ ...record, state: 'provisioning' })
    },

    close(id: string, expectedGeneration: number): BrowserLaneRecord {
      const record = lane(id)
      assertGeneration(record, expectedGeneration)
      if (record.state === 'closed') return record
      return save({ ...record, state: 'closed', automationOwner: 'none', recording: false })
    },

    closeForSession(runtimeSessionId: string): void {
      for (const record of lanes.values())
        if (record.runtimeSessionId === runtimeSessionId && record.state !== 'closed')
          lanes.set(record.id, { ...record, state: 'closed', automationOwner: 'none' })
    },
  }

  function save(record: BrowserLaneRecord): BrowserLaneRecord {
    lanes.set(record.id, record)
    return record
  }

  return registry
}

export type BrowserLaneRegistry = ReturnType<typeof createBrowserLaneRegistry>
