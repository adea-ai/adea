import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import {
  createDatabase,
  createTemporaryUserSession,
  createWorkspaceWithOwner,
  ensureWorkspaceLead,
  createDirectAgentTopic,
  createLeadTurn,
  workspaces,
  messages,
  workspaceEvents,
  workspaceMemberships,
} from '@adea-ai/db'
import { createLeadTurnProduct } from '../../../../apps/web/src/server/lead-turn-product.ts'
import { createConfiguredLeadTurnDependencies } from '../../../../apps/web/src/server/lead-turn-composition.ts'
import { timelineCompositionFixture } from '../../../../apps/web/test/helpers/lead-timeline-composition-fixture.ts'

if (!process.env.DATABASE_URL) throw new Error('Owned restricted database required')
const connection = createDatabase(process.env.DATABASE_URL)
try {
  const owner = await createTemporaryUserSession(connection.db, {
    credentialDigest: crypto.randomUUID(),
    expiresAt: new Date(Date.now() + 60_000),
  })
  const { workspace } = await createWorkspaceWithOwner(connection.db, {
    name: 'Timeline publication proof',
    owner: owner.principal,
    idempotencyKey: crypto.randomUUID(),
  })
  const lead = await ensureWorkspaceLead(connection.db, workspace.id, owner.principal)
  const topic = await createDirectAgentTopic(
    connection.db,
    workspace.id,
    lead.id,
    owner.principal,
    {
      title: 'Exact publication',
      idempotencyKey: crypto.randomUUID(),
    }
  )
  const admitted = await createLeadTurn(connection.db, workspace.id, topic.id, owner.principal, {
    bodyText: 'Synthetic canonical question',
    idempotencyKey: crypto.randomUUID(),
  })
  const [mapped] = await connection.db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspace.id))
  assert.ok(mapped?.controlPlaneWorkspaceId)
  const scope = {
    workspaceId: workspace.id,
    intentId: admitted.leadTurn.intentId,
    userId: owner.principal.userId,
  }
  const cp = await timelineCompositionFixture({
    workspaceId: mapped.controlPlaneWorkspaceId,
    intentId: scope.intentId,
    originalActorRef: `user:${scope.userId}`,
    text: 'Exact accepted answer\n',
  })
  const product = createLeadTurnProduct(connection.db, cp.dependencies)
  assert.equal((await product.prepare(scope)).state, 'prepared')
  assert.equal((await product.dispatch(scope)).state, 'running')
  const channelRows = () =>
    connection.db.select().from(messages).where(eq(messages.channelId, topic.id))
  cp.denyPublication(true)
  assert.equal((await product.status(scope)).reasonCode, 'PUBLICATION_WITHHELD')
  assert.equal((await channelRows()).length, 1)
  cp.denyPublication(false)
  for (const change of [
    { canonicalActorPrincipalId: `user:${crypto.randomUUID()}` },
    { attemptId: `att_${'1'.repeat(26)}` },
    { resultContentDigest: `sha256:${'0'.repeat(64)}` },
  ]) {
    cp.resetPublication()
    cp.changePublication(change)
    assert.equal((await product.status(scope)).reasonCode, 'PUBLICATION_WITHHELD')
    assert.equal((await channelRows()).length, 1)
  }
  cp.resetPublication()
  const completed = await product.status(scope)
  assert.equal(completed.state, 'completed')
  assert.ok(completed.publishedMessageId)
  const replay = await product.status(scope)
  assert.equal(replay.publishedMessageId, completed.publishedMessageId)
  const rows = await channelRows()
  assert.equal(rows.length, 2)
  const output = rows.find((row) => row.id === completed.publishedMessageId)
  assert.equal(output.bodyText, 'Exact accepted answer\n')
  assert.equal(output.senderAgentId, lead.id)
  assert.equal(output.executionRef, cp.binding.executionId)
  assert.equal(output.externalSessionRef, cp.binding.runtimeSessionId)
  const events = await connection.db
    .select()
    .from(workspaceEvents)
    .where(eq(workspaceEvents.workspaceId, workspace.id))
  assert.equal(events.filter((event) => event.eventType === 'message.created').length, 2)
  assert.equal(cp.calls.filter((call) => call.method === 'dispatchPiDurableLead').length, 1)
  await connection.db
    .delete(workspaceMemberships)
    .where(eq(workspaceMemberships.workspaceId, workspace.id))
  await assert.rejects(() => product.status(scope), /unavailable/)
  assert.equal((await channelRows()).length, 2)
  assert.equal(cp.calls.filter((call) => call.method === 'dispatchPiDurableLead').length, 1)
  let resolved = false
  assert.deepEqual(
    await createConfiguredLeadTurnDependencies({
      environment: {},
      resolveControlPlaneScope: async () => {
        resolved = true
        return { workspaceId: mapped.controlPlaneWorkspaceId }
      },
    }),
    {}
  )
  assert.equal(resolved, false)
  console.log(
    JSON.stringify({
      schemaVersion: 'adea-timeline-publication-proof/v1',
      configuredAdeaComposition: true,
      canonicalPostgresPublication: true,
      publicationWithheldBeforeCurrentGrant: true,
      changedActorAttemptDigestDenied: true,
      exactUtf8AndSessionPins: true,
      oneTimelineAppend: true,
      stableReplay: true,
      revokedOriginalActorDenied: true,
      dispatchCalls: 1,
      cpTransport: 'mock',
      cpPublicationAuthority: 'mock',
      sdkPackageIntegration: false,
      physicalInference: false,
      liveProvider: false,
      credentialFixtures: 'synthetic in-memory signing',
    })
  )
} finally {
  await connection.close()
}
