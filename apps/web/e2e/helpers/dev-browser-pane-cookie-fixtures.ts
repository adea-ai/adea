/*
 * Decoder-exact fixture replies for the cookie-import surface (#646). The
 * browser-pane harness serves these through the same `DevRuntimeService` seam
 * the pane uses in production, and `dev-browser-pane-cookie-fixtures.test.ts`
 * pins every reply through `decodeDevReply` — the operations' own decoders —
 * so the render lane exercises the wire shapes the packaged app would see.
 *
 * The fixtures are value-free the way the real wire is: a `CookieSource` row
 * carries no store path, a plan carries counts and domains, a commit result
 * carries counts. No cookie value or name exists anywhere in this module.
 */
import type {
  BrowserLane,
  DevCommand,
  DevError,
  DevReply,
  Scope,
} from '@adea-ai/types/dev-runtime'

/**
 * Mirrors the wire `CookieSource` decoder (id, kind, label, availability) —
 * the types package ships the decoder but not a named DTO for it.
 */
type FixtureCookieSource = Readonly<{
  id: string
  kind: 'chrome' | 'chromium' | 'brave' | 'edge' | 'firefox' | 'safari'
  label: string
  availability: 'available' | 'locked' | 'unsupported_format' | 'unreadable'
  detail?: string
}>

/**
 * The harness scope. UUIDs, because a cookie plan embeds the command scope and
 * the plan decoder requires the wire `Scope` shape — the readable fixture ids
 * stay on lanes and profiles, which are opaque strings on the wire.
 */
export const browserPaneFixtureScope: Scope = {
  accountId: '00000000-0000-4000-8000-0000000000a1',
  workspaceId: '00000000-0000-4000-8000-0000000000a2',
  runtimeNodeId: '00000000-0000-4000-8000-0000000000a3',
}

/** Query-parameter variants (`?cookies=…`) that select a fixture reply. */
export type CookieFixtureMode = 'ok' | 'blocked' | 'keychain' | 'stale' | 'sources-unavailable'

const COOKIE_FIXTURE_MODES: readonly CookieFixtureMode[] = [
  'ok',
  'blocked',
  'keychain',
  'stale',
  'sources-unavailable',
]

export function cookieFixtureMode(search: URLSearchParams): CookieFixtureMode {
  const requested = search.get('cookies')
  return COOKIE_FIXTURE_MODES.includes(requested as CookieFixtureMode)
    ? (requested as CookieFixtureMode)
    : 'ok'
}

export type CookieFixtureLane = Readonly<{
  id: string
  generation: number
  state: BrowserLane['state']
}>

/**
 * One typed row per detected profile, including the two this runtime cannot
 * read: a locked browser and an unsupported format are rows with their reason,
 * never an absence that reads as "no browsers installed".
 */
export const fixtureCookieSourceRows: readonly FixtureCookieSource[] = [
  {
    id: 'chrome:Default',
    kind: 'chrome',
    label: 'Google Chrome — Default',
    availability: 'available',
  },
  {
    id: 'firefox:dev-edition',
    kind: 'firefox',
    label: 'Firefox — dev',
    availability: 'locked',
    detail: 'the running browser holds its cookie store open',
  },
  {
    id: 'safari:legacy',
    kind: 'safari',
    label: 'Safari',
    availability: 'unsupported_format',
    detail: 'this profile stores cookies in a format this runtime cannot read',
  },
]

export const fixtureCookiePlanId = '00000000-0000-4000-8000-0000000000c1'
export const fixtureCookiePlanDigest = 'a'.repeat(64)

const FIXTURE_OBSERVED_AT = '2026-01-01T00:00:00.000Z'

function okReply(command: DevCommand, value: unknown): DevReply {
  return {
    schemaVersion: 1,
    operation: command.operation,
    requestId: command.requestId,
    ok: true,
    value,
    observedAt: FIXTURE_OBSERVED_AT,
  } as DevReply
}

function errorReply(command: DevCommand, error: DevError): DevReply {
  // The wire refusal carries no top-level observedAt — the decoder forbids it;
  // the timestamp lives inside the DevError, as the M10 authority builds it.
  return {
    schemaVersion: 1,
    operation: command.operation,
    requestId: command.requestId,
    ok: false,
    error: { ...error, observedAt: FIXTURE_OBSERVED_AT },
  } as DevReply
}

/** `dev.browser.cookieSources`: one complete typed page (or its typed refusal). */
export function cookieSourcesReply(command: DevCommand, mode: CookieFixtureMode): DevReply {
  if (mode === 'sources-unavailable') {
    return errorReply(command, {
      code: 'unavailable',
      retryable: true,
      message: 'fixture cookie source read failed',
    })
  }
  return okReply(command, { items: fixtureCookieSourceRows, observedAt: FIXTURE_OBSERVED_AT })
}

/**
 * `dev.browser.cookieImportPlan`: the value-free `MutationPlan` — families,
 * staged counts, skips, blockers — or the keychain refusal a denied read
 * produces in production (`cookie_import_failed`, never plaintext).
 */
export function cookieImportPlanReply(
  command: DevCommand,
  lane: CookieFixtureLane,
  mode: CookieFixtureMode
): DevReply {
  if (mode === 'keychain') {
    return errorReply(command, {
      code: 'cookie_import_failed',
      retryable: false,
      message:
        'the "Chromium Safe Storage" Keychain item could not be read; cookies are never written unencrypted',
    })
  }
  return okReply(command, {
    id: fixtureCookiePlanId,
    operation: 'dev.browser.cookieImportCommit',
    scope: command.scope,
    resource: { kind: 'browser_lane', id: lane.id, generation: lane.generation },
    factVersions: {
      sourceProfileId: 'chrome:Default',
      domains: 'example.com,github.com',
      stagedWrites: '12',
      stagedRemovals: '4',
      skipped: '3',
    },
    steps: [
      { id: 'remove', kind: 'cookie_remove', targetId: lane.id, dependsOn: [] },
      { id: 'write', kind: 'cookie_write', targetId: lane.id, dependsOn: ['remove'] },
    ],
    blockers:
      mode === 'blocked'
        ? [
            {
              code: 'invalid_state',
              message: 'the lane engine still owns this profile; close the lane before importing',
            },
          ]
        : [],
    requiredApprovalIds: [],
    digest: fixtureCookiePlanDigest,
    // Fresh for the whole test run: the surface must treat the plan as
    // committable on its own merits, not trip over an early expiry.
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  })
}

/**
 * `dev.browser.cookieImportCommit`, in the order the real seam refuses: the
 * lane must be stopped first (`invalid_state`), then a plan staged against a
 * moved generation is `plan_stale`, and only then does the import apply.
 */
export function cookieImportCommitReply(
  command: DevCommand,
  lane: CookieFixtureLane,
  mode: CookieFixtureMode
): DevReply {
  const IDLE_STATES: readonly BrowserLane['state'][] = ['provisioning', 'closed', 'crashed']
  if (!IDLE_STATES.includes(lane.state)) {
    return errorReply(command, {
      code: 'invalid_state',
      retryable: true,
      message: `close the browser lane before importing cookies (lane is ${lane.state})`,
    })
  }
  if (mode === 'stale') {
    return errorReply(command, {
      code: 'plan_stale',
      retryable: false,
      // The fixture models a lane that advanced after the plan was staged.
      message: `lane generation moved to ${lane.generation + 1}; preview the import again`,
    })
  }
  return okReply(command, {
    browserLaneId: lane.id,
    imported: 12,
    skipped: 3,
    rolledBack: false,
    observedAt: FIXTURE_OBSERVED_AT,
  })
}
