import { expect, test } from 'bun:test'
import type {
  ApiRuntimeConnection,
  ApiRuntimeNode,
  ApiRuntimeNodeConnectionsResponse,
} from '@adea-ai/api-client'
import {
  classifyFailure,
  diagnoseHost,
  executionAuthority,
  historyAuthority,
  hostHeadline,
  hostsRegisteredSince,
  hostIdentityLabel,
  hostNameProblem,
  hostSelectability,
  pairingRemaining,
  pairingState,
  remediationSteps,
  revocationOutcome,
  revokeReasonProblem,
  REVOCATION_EFFECTS,
  type DiscoveryRead,
  type HostInput,
} from '../../src/self-hosted-connection-model'

const now = Date.parse('2026-10-15T12:00:00.000Z')
const iso = (offset = 0) => new Date(now + offset).toISOString()

function node(overrides: Partial<ApiRuntimeNode> = {}): ApiRuntimeNode {
  return {
    id: '00000000-0000-4000-8000-000000000002',
    controlPlaneRuntimeNodeRefId: `rnr_${'0'.repeat(20)}ABCDEF`,
    displayName: 'Home server',
    kind: 'remote_host',
    health: 'healthy',
    pairingState: 'paired',
    lastProofAt: iso(-30_000),
    lastSeenAt: iso(-30_000),
    platform: 'Linux',
    softwareVersion: '1.72.0',
    ...overrides,
  }
}

function connection(overrides: Partial<ApiRuntimeConnection> = {}): ApiRuntimeConnection {
  return {
    id: 'rc_1',
    runtimeDefinitionId: 'managed-pi',
    family: 'pi',
    connectionType: 'managed_local',
    location: 'remote_host',
    status: 'available',
    node: {
      runtimeNodeRefId: 'rnr_x',
      location: 'remote_host',
      status: 'online',
      health: 'online',
      observedAt: iso(-10_000),
    },
    connection: { status: 'connected', health: 'healthy', availability: 'healthy' },
    freshness: { state: 'fresh', observedAt: iso(-10_000) },
    versions: { adapter: '1.2.0', driver: '1.2.0', harness: '1.0.0', protocol: '3.0' },
    capabilities: ['chat', 'tools'],
    capabilityDetails: [
      { name: 'chat', support: 'supported' },
      { name: 'tools', support: 'supported' },
    ],
    compatibility: { state: 'compatible', limitations: [] },
    access: {
      localProjectGrant: { required: false, state: 'not_required' },
      entitlement: { state: 'allowed' },
    },
    eligibility: { state: 'eligible', reasons: [], degradations: [], remediation: [] },
    transport: { state: 'unreported' },
    observedAt: iso(-10_000),
    limitations: [],
    ...overrides,
  }
}

function page(
  host: ApiRuntimeNode,
  connections: ApiRuntimeConnection[],
  discovery: ApiRuntimeNodeConnectionsResponse['discovery'] = { state: 'available' }
): DiscoveryRead {
  return {
    state: 'read',
    page: {
      node: {
        id: host.id,
        controlPlaneRuntimeNodeRefId: host.controlPlaneRuntimeNodeRefId,
        kind: host.kind,
        displayName: host.displayName,
        health: host.health,
        pairingState: host.pairingState,
        lastProofAt: host.lastProofAt,
      },
      discovery,
      connections,
      observedAt: iso(-10_000),
    },
  }
}

function input(overrides: Partial<HostInput> = {}): HostInput {
  const host = overrides.node ?? node()
  return { node: host, discovery: page(host, [connection()]), ...overrides }
}

const byId = (host: HostInput, id: string) =>
  diagnoseHost(host, now).find((item) => item.id === id)!

test('a recent proof and a compatible report read as reported eligible, never as ready', () => {
  const host = input()
  expect(hostHeadline(host, now)).toEqual({ label: 'Reported eligible', tone: 'success' })
  expect(byId(host, 'proof').detail).toContain('does not authorize work')
  expect(byId(host, 'registration').detail).toContain('does not show the host is running')
  expect(hostSelectability(host, now)).toEqual({ allowed: true, blockers: [] })
})

test('online evidence never implies authorization or compatibility', () => {
  // Recent proof and a healthy connection, but the runtime is incompatible and entitlement denied.
  const bad = connection({
    compatibility: { state: 'incompatible', limitations: ['protocol 2 is not supported'] },
    access: {
      localProjectGrant: { required: true, state: 'missing' },
      entitlement: { state: 'denied' },
    },
    eligibility: {
      state: 'ineligible',
      reasons: ['incompatible'],
      degradations: [],
      remediation: ['upgrade_control_plane'],
    },
  })
  const host = input({ discovery: page(node(), [bad]) })
  expect(byId(host, 'proof').tone).toBe('success')
  expect(hostHeadline(host, now)).toEqual({ label: 'Incompatible', tone: 'danger' })
  expect(byId(host, 'access').verdict).toBe('Restricted')
  expect(hostSelectability(host, now).allowed).toBe(false)
  expect(hostSelectability(host, now).blockers).toContain('Version compatibility: Incompatible')
  expect(byId(host, 'compatibility').detail).toContain('protocol 2 is not supported')
})

test('version mismatch states give distinct, actionable remediation without an invented minimum', () => {
  for (const state of ['incompatible', 'deprecated'] as const) {
    const host = input({
      discovery: page(node(), [connection({ compatibility: { state, limitations: [] } })]),
    })
    const diagnostic = byId(host, 'compatibility')
    expect(diagnostic.action).toBe('upgrade_or_select_compatible_location')
    expect(diagnostic.detail).toContain('registered software 1.72.0')
    expect(diagnostic.detail).toContain('protocol 3.0')
    expect(remediationSteps([diagnostic])[0]).toContain('Update the host')
  }
  expect(
    byId(
      input({
        discovery: page(node(), [
          connection({ compatibility: { state: 'deprecated', limitations: [] } }),
        ]),
      }),
      'compatibility'
    ).verdict
  ).toBe('Update needed')
  // No report, no claim: unknown, and the registered version is stated as a fact.
  const unread = byId(input({ discovery: { state: 'not_read' } }), 'compatibility')
  expect(unread.tone).toBe('unknown')
  expect(unread.detail).toContain('registered software 1.72.0')
})

test('endpoint failure and an unavailable Control Plane stay unknown, not offline', () => {
  const failed = input({ discovery: { state: 'failed', status: 503 } })
  expect(byId(failed, 'discovery')).toMatchObject({ tone: 'unknown', verdict: 'Could not check' })
  expect(byId(failed, 'discovery').detail).toContain(
    'says nothing about whether the host is running'
  )
  expect(hostHeadline(failed, now).tone).toBe('unknown')

  const unavailable = input({
    discovery: page(node(), [], { state: 'unavailable', code: 'CONTROL_PLANE_UNAVAILABLE' }),
  })
  expect(byId(unavailable, 'discovery')).toMatchObject({
    tone: 'unknown',
    verdict: 'No report received',
  })
  // Unavailable is not the same as an available, empty inventory.
  const empty = input({ discovery: page(node(), []) })
  expect(byId(empty, 'discovery')).toMatchObject({
    tone: 'warning',
    verdict: 'No runtimes reported',
  })
  expect(hostSelectability(unavailable, now).allowed).toBe(false)
})

test('a stale or unknown proof is a warning or unknown and points to reconnecting', () => {
  const stale = input({ node: node({ health: 'stale', lastProofAt: iso(-600_000) }) })
  expect(byId(stale, 'proof')).toMatchObject({ tone: 'warning', action: 'reconnect_location' })
  expect(remediationSteps([byId(stale, 'proof')])[0]).toContain('registration agent')
  const unknown = input({ node: node({ health: 'unknown', lastProofAt: null }) })
  expect(byId(unknown, 'proof').tone).toBe('unknown')
  const future = input({ node: node({ lastProofAt: iso(60_000) }) })
  expect(byId(future, 'proof').tone).toBe('unknown')
})

test('revocation seen on either read wins, and a mismatched discovery page is ignored', () => {
  const host = node()
  const revokedElsewhere: DiscoveryRead = page({ ...host, pairingState: 'revoked' }, [connection()])
  expect(byId(input({ node: host, discovery: revokedElsewhere }), 'registration').tone).toBe(
    'danger'
  )
  expect(hostHeadline(input({ node: host, discovery: revokedElsewhere }), now).label).toBe(
    'Revoked'
  )

  // A page for another registered identity cannot revoke or upgrade this host.
  const other = node({ id: '00000000-0000-4000-8000-0000000000ff', pairingState: 'revoked' })
  expect(
    byId(input({ node: host, discovery: page(other, [connection()]) }), 'registration').tone
  ).toBe('success')
  // The list read says revoked even if the discovery page predates it.
  const listRevoked = input({
    node: node({ pairingState: 'revoked' }),
    discovery: page(host, [connection()]),
  })
  expect(hostHeadline(listRevoked, now).label).toBe('Revoked')
  expect(byId(listRevoked, 'proof').verdict).toBe('Not applicable')
  // A revoked host is not asked about work: its reports are not applicable, and say nothing odd.
  for (const id of ['discovery', 'compatibility', 'capabilities', 'access'])
    expect(byId(listRevoked, id)).toMatchObject({ tone: 'neutral', verdict: 'Not applicable' })
  expect(remediationSteps(diagnoseHost(listRevoked, now))).toEqual([
    'Register the host again to create a new identity, or choose a different host.',
  ])
})

test('unavailable capabilities are explained from the report, not guessed', () => {
  const limited = connection({
    capabilities: ['chat'],
    capabilityDetails: [
      { name: 'chat', support: 'supported' },
      { name: 'browser', support: 'unsupported', limitations: ['no display server on this host'] },
    ],
  })
  const host = input({
    discovery: page(node(), [limited]),
    requiredCapabilities: ['chat', 'browser'],
  })
  const diagnostic = byId(host, 'capabilities')
  expect(diagnostic).toMatchObject({ tone: 'danger', verdict: 'Missing capabilities' })
  expect(diagnostic.detail).toContain('browser')
  expect(diagnostic.detail).toContain('based on what each runtime reported')
  expect(hostSelectability(host, now).allowed).toBe(false)
  const noRequirement = input({ discovery: page(node(), [limited]) })
  expect(byId(noRequirement, 'capabilities').detail).toContain('no display server on this host')
})

test('selection needs one runtime that passes every check on its own', () => {
  const missingTools = connection({
    id: 'a',
    capabilities: ['chat'],
    capabilityDetails: [{ name: 'chat', support: 'supported' }],
  })
  const incompatibleChatTools = connection({
    id: 'b',
    compatibility: { state: 'incompatible', limitations: [] },
  })
  const host = input({
    discovery: page(node(), [missingTools, incompatibleChatTools]),
    requiredCapabilities: ['chat', 'tools'],
  })
  const result = hostSelectability(host, now)
  expect(result.allowed).toBe(false)
  expect(result.blockers.join(' ')).toContain('Version compatibility')
})

test('execution and synchronized history are separate authorities, and history stays unknown', () => {
  const states: HostInput[] = [
    input(),
    input({ node: node({ pairingState: 'revoked' }) }),
    input({ node: node({ health: 'stale', lastProofAt: iso(-900_000) }) }),
    input({ discovery: { state: 'failed' } }),
  ]
  const history = historyAuthority()
  for (const host of states) {
    // The history panel does not take the host as input at all: it cannot vary with it.
    expect(executionAuthority(host, now).id).toBe('execution')
    expect(history.tone).toBe('unknown')
  }
  expect(executionAuthority(states[1]!, now).verdict).toBe('Revoked')
  const text = JSON.stringify(history)
  expect(text).toContain('does not grant history decryption')
  expect(text).toContain('does not revoke history access')
  expect(text).not.toMatch(/online|offline|healthy|revoked host/iu)
})

test('revocation copy does not claim to erase data or revoke history access', () => {
  const doesNot = REVOCATION_EFFECTS.doesNot.join(' ')
  expect(doesNot).toContain('does not delete anything on the host')
  expect(doesNot).toContain('does not change who can read synchronized history')
  expect(doesNot).toContain('does not cancel work the host has already accepted')
  const does = REVOCATION_EFFECTS.does.join(' ')
  expect(does).not.toMatch(/delet|eras|wip|history|decrypt/iu)
})

test('failures map stable codes to distinct recovery, and never echo server text', () => {
  const cases: [unknown, string, string][] = [
    [{ code: 'challenge_expired', status: 409 }, 'expired', 'new_pairing'],
    [{ code: 'challenge_used', status: 409 }, 'replayed', 'new_pairing'],
    [{ code: 'exchange_credential_invalid', status: 409 }, 'credential_rejected', 'new_pairing'],
    [{ code: 'unauthorized', status: 403 }, 'forbidden', 'switch_account'],
    [{ status: 403 }, 'forbidden', 'switch_account'],
    [{ status: 401 }, 'signed_out', 'sign_in'],
    [{ code: 'key_mismatch', status: 409 }, 'invalid', 'same'],
    [{ status: 503 }, 'endpoint', 'same'],
    [new TypeError('Failed to fetch'), 'endpoint', 'same'],
    [{ status: 409 }, 'stale_state', 'refresh'],
    [{ status: 418 }, 'unknown', 'refresh'],
  ]
  for (const [error, kind, retry] of cases) {
    const result = classifyFailure(error, 'pairing')
    expect({ kind: result.kind, retry: result.retry }).toEqual({ kind, retry })
  }
  expect(classifyFailure({ code: 'revoked', status: 409 }, 'pairing').kind).toBe('revoked_identity')
  // A revoke that finds the host already revoked is stale view state, not an error to blame.
  expect(classifyFailure({ code: 'revoked', status: 409 }, 'revoke')).toMatchObject({
    kind: 'stale_state',
    retry: 'refresh',
  })
  expect(classifyFailure({ code: 'not_found', status: 404 }, 'revoke').kind).toBe('stale_state')
  const leaky = classifyFailure({ status: 500, message: 'sensitive-error-canary' }, 'read')
  expect(JSON.stringify(leaky)).not.toContain('sensitive-error-canary')
})

test('a pairing is discarded on scope change and expires, and another host appearing never marks it used', () => {
  const scope = { accountId: 'user-a', workspaceId: 'ws-1' }
  const grant = { expiresAt: iso(600_000), issuedAt: now, scope }
  const current = { hostIds: ['h1'], hostIdsAtIssue: ['h1'], scope }
  expect(pairingState(grant, current, now)).toBe('active')
  expect(pairingState(grant, current, now + 600_000)).toBe('expired')
  // Another host appearing cannot be tied to this challenge, so it never marks it used.
  expect(pairingState(grant, { ...current, hostIds: ['h1', 'h2'] }, now + 1_000)).toBe('active')
  expect(hostsRegisteredSince(['h1', 'h2'], ['h1'])).toEqual(['h2'])
  expect(hostsRegisteredSince(['h1'], ['h1'])).toEqual([])
  // Wrong account or workspace: the pairing the previous scope created is not carried over.
  expect(pairingState(grant, { ...current, scope: { ...scope, accountId: 'user-b' } }, now)).toBe(
    'discarded'
  )
  expect(pairingState(grant, { ...current, scope: { ...scope, workspaceId: 'ws-2' } }, now)).toBe(
    'discarded'
  )
  // An invalid expiry never reads as active.
  expect(pairingState({ ...grant, expiresAt: 'nonsense' }, current, now)).toBe('expired')
  expect(pairingRemaining(iso(125_000), now)).toBe('2:05 left')
  expect(pairingRemaining(iso(-1), now)).toBe('Expired')
})

test('rename and revoke drafts are validated with the server bounds and keep hosts distinct', () => {
  const hosts = [
    { id: 'a', displayName: 'Home server' },
    { id: 'b', displayName: 'Office box' },
  ]
  expect(hostNameProblem('  ', hosts, 'a')).toBe('Enter a name.')
  expect(hostNameProblem('x'.repeat(121), hosts, 'a')).toContain('120')
  expect(hostNameProblem('bad\u0007name', hosts, 'a')).toContain('control')
  expect(hostNameProblem('office BOX', hosts, 'a')).toContain('distinct')
  expect(hostNameProblem('Home server', hosts, 'a')).toBeUndefined()
  expect(hostNameProblem('Rack 2', hosts, 'a')).toBeUndefined()
  expect(revokeReasonProblem('')).toContain('reason')
  expect(revokeReasonProblem('x'.repeat(201))).toContain('200')
  expect(revokeReasonProblem('Decommissioned')).toBeUndefined()
})

test('stale revocation: an accepted revoke is confirmed only by a later read', () => {
  expect(revocationOutcome(false, undefined, false)).toBe('pending')
  expect(revocationOutcome(true, { pairingState: 'paired' }, false)).toBe('pending')
  expect(revocationOutcome(true, { pairingState: 'paired' }, true)).toBe('not_confirmed')
  expect(revocationOutcome(true, { pairingState: 'revoked' }, true)).toBe('confirmed')
  expect(revocationOutcome(true, undefined, true)).toBe('host_missing')
})

test('similar hosts stay distinct by platform, version and reference suffix', () => {
  const first = node({ id: 'a', controlPlaneRuntimeNodeRefId: `rnr_${'0'.repeat(20)}AAAAAA` })
  const second = node({ id: 'b', controlPlaneRuntimeNodeRefId: `rnr_${'0'.repeat(20)}BBBBBB` })
  expect(first.displayName).toBe(second.displayName)
  expect(hostIdentityLabel(first)).not.toBe(hostIdentityLabel(second))
  expect(hostIdentityLabel(first)).toContain('…AAAAAA')
})

test('the self-hosted surface stays isolated from the inventory pane and the details dialog', async () => {
  // Entry-point changes belong to the owner of those files; this surface must not import them,
  // so it can ship and be tested alone.
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = join(import.meta.dir, '../../src')
  for (const module of [
    'self-hosted-connection-model.ts',
    'self-hosted-connection-panel.tsx',
    'self-hosted-connection-pane.tsx',
    'self-hosted-setup-guide.tsx',
  ]) {
    const code = readFileSync(join(src, module), 'utf8')
    for (const forbidden of ['runtime-nodes-pane', 'workspace-details-dialog', 'platform'])
      expect(code).not.toMatch(new RegExp(`from '\\./${forbidden}'`))
  }
})

test('a fresh compatible report with unknown entitlement is not summarised as eligible', () => {
  const host = node()
  const unknown = input({
    node: host,
    discovery: page(host, [
      connection({
        access: {
          localProjectGrant: { required: false, state: 'not_required' },
          entitlement: { state: 'unknown' },
        },
      }),
    ]),
  })
  expect(hostHeadline(unknown, now)).toEqual({ label: 'Access unknown', tone: 'unknown' })
  // The headline and the selection gate agree.
  expect(hostSelectability(unknown, now).allowed).toBe(false)
  expect(hostSelectability(unknown, now).blockers.join(' ')).toContain('Unknown')
})

test('a report must carry both identity fields before any of its facts are used', () => {
  const host = node()
  const good = page(host, [connection()])
  for (const mismatch of [
    { controlPlaneRuntimeNodeRefId: 'rnr_other' },
    { id: 'other-node' },
    { id: 'other-node', controlPlaneRuntimeNodeRefId: 'rnr_other' },
  ]) {
    if (good.state !== 'read') throw new Error('fixture')
    const wrong: HostInput = {
      node: host,
      discovery: {
        state: 'read',
        page: { ...good.page, node: { ...good.page.node, ...mismatch } },
      },
    }
    expect(byId(wrong, 'discovery')).toMatchObject({
      tone: 'unknown',
      verdict: 'Report names another identity',
    })
    // No eligibility, compatibility, capability or access fact is taken from it.
    expect(byId(wrong, 'compatibility').verdict).toBe('Not checked')
    expect(byId(wrong, 'capabilities').verdict).toBe('Not reported')
    expect(byId(wrong, 'access').verdict).toBe('Not reported')
    expect(hostHeadline(wrong, now).label).not.toBe('Reported eligible')
    expect(hostSelectability(wrong, now).allowed).toBe(false)
  }
  expect(hostHeadline({ node: host, discovery: good }, now).label).toBe('Reported eligible')
})
