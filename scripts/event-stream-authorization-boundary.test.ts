// The event stream is authorized with the permissions catalog's
// `workspace.events.read`, not the general `workspace.read`. This is an
// invariant worth pinning by reading the source: every role that can read a
// workspace also holds the events permission today, so a regression to
// `workspace.read` is invisible to behaviour tests, and only the catalog
// reference would notice.

import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// The workspace package is not linked into the root's node_modules, so this
// reads the permission map from its source. The map is the fact under test;
// importing a build output would only prove dist is up to date.
import { workspaceRolePermissions } from '../packages/auth/src/authorization'

const root = new URL('..', import.meta.url).pathname
const EVENTS_ROUTE = 'apps/web/src/start/routes/api/v1/workspaces/$workspaceId/events.ts'
const STREAM_DECISIONS = 'apps/web/src/server/workspace-event-stream.ts'

describe('workspace event stream authorization', () => {
  test('authorizes with the events permission, never the general read', async () => {
    const route = await readFile(join(root, EVENTS_ROUTE), 'utf8')

    expect(route).toContain("'workspace.events.read'")
    expect(route).not.toContain("'workspace.read'")
    // Both the first byte and the mid-stream revalidation are covered: the
    // recheck is what ends a stream for a subscription that lost access. The
    // permission appears at least once per call, comments included.
    expect(route.match(/authorizeWorkspace\(/g)).toHaveLength(2)
    expect(route.match(/'workspace\.events\.read'/g)?.length).toBeGreaterThanOrEqual(2)
  })

  test('every role that can read a workspace also holds the events permission', async () => {
    for (const [role, permissions] of Object.entries(workspaceRolePermissions)) {
      const granted = permissions as readonly string[]
      expect(granted).toContain('workspace.read')
      // Without this, switching the stream to the events permission would strip
      // every role's ability to subscribe.
      expect(granted, `${role} cannot read workspace events`).toContain('workspace.events.read')
    }
  })

  test('the revalidation decision names the reason it ended the stream', async () => {
    const stream = await readFile(join(root, STREAM_DECISIONS), 'utf8')

    // The ending frame tells the client which authorization changed, so the two
    // recheck branches stay distinguishable.
    expect(stream).toContain('function revalidationOutcome')
    expect(stream).toContain("'session-revoked'")
    expect(stream).toContain("'membership-revoked'")
  })
})
