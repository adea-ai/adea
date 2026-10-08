// TEST ONLY. Isolated PostgreSQL evidence adapter for the packed CP candidate.
// No production import, runtime activation, credential read, or project synthesis.
import { randomUUID } from 'node:crypto'
import { and, count, eq, sql } from 'drizzle-orm'
import { changeAgentProfile, ensureWorkspaceLead, getWorkspaceLeadForUser } from '../../src/agents'
import { createDatabase } from '../../src/connection'
import { createDirectAgentTopic, createMessage } from '../../src/conversations'
import { createTemporaryUserSession } from '../../src/identity'
import { createLeadTurn, getLeadTurnForUser } from '../../src/lead-turns'
import { agents, messages, workspaceEvents, workspaces } from '../../src/schema'
import { leadTurnIntents } from '../../src/schema/lead-turns'
import { createWorkspaceWithOwner } from '../../src/workspaces'

const FIXTURE_BODY = 'Test-only canonical Adea workspace lead question'
const CP_PROFILE = /^prf_[0-9A-HJKMNP-TV-Z]{26}$/
const CP_PROFILE_VERSION = /^pfv_[0-9A-HJKMNP-TV-Z]{26}$/

export type CandidateHostPins = Readonly<{
  profileVersionId: string
  profileContentDigest: string
  selectionRef: string
  selectionRevision: number
  principalId: string
  expiresAt: string
}>

/** Mirrors the exact R1 trusted product port, without importing another checkout. */
export type CandidateIntentEvidence = Readonly<{
  schemaVersion: 'pi-lead-intent/v1'
  intentId: string
  workspaceId: string
  projectId: null
  messageRef: string
  authorityRevision: number
  principalRef: string
  canonicalActorPrincipalId?: string
  scopeRef: string
  expiresAt: string
  allowedPrincipalIds: readonly string[]
  selectionRef: string
  selectionRevision: number
  prompt: string
  profileVersionId: string
  profileContentDigest: string
}>

function validateFixtureDatabase(databaseUrl: string) {
  const url = new URL(databaseUrl)
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.search ||
    url.hash ||
    !/^\/adea_(?:foundations(?:_[a-z0-9_]+)?|pi_candidate(?:_[a-z0-9_]+)?)$/.test(url.pathname)
  )
    throw new Error('CANDIDATE_ISOLATED_LOOPBACK_DATABASE_REQUIRED')
}

function validateHostPins(pins: CandidateHostPins) {
  if (
    !CP_PROFILE_VERSION.test(pins.profileVersionId) ||
    !/^sha256:[a-f0-9]{64}$/.test(pins.profileContentDigest) ||
    !/^msel_[a-f0-9]{32}$/.test(pins.selectionRef) ||
    !Number.isSafeInteger(pins.selectionRevision) ||
    pins.selectionRevision < 1 ||
    !pins.principalId ||
    pins.principalId.length > 256 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(pins.expiresAt) ||
    !Number.isFinite(Date.parse(pins.expiresAt)) ||
    Date.parse(pins.expiresAt) <= Date.now()
  )
    throw new Error('CANDIDATE_HOST_PINS_INVALID')
}

/** Caller owns `try/finally { await fixture.close() }`; isolated fixture rows are retained. */
export async function createAdeaIntentFixture(databaseUrl: string) {
  validateFixtureDatabase(databaseUrl)
  const connection = createDatabase(databaseUrl)
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await connection.close()
  }
  const requireOpen = () => {
    if (closed) throw new Error('CANDIDATE_FIXTURE_CLOSED')
  }
  try {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: `candidate-owner:${randomUUID()}`,
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      owner: owner.principal,
      name: 'Test-only Pi candidate workspace',
      idempotencyKey: `candidate-workspace:${randomUUID()}`,
    })
    const [workspaceRow] = await connection.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspace.id))
    if (!workspaceRow) throw new Error('CANDIDATE_CANONICAL_WORKSPACE_MISSING')
    const lead = await ensureWorkspaceLead(connection.db, workspace.id, owner.principal)
    const topic = await createDirectAgentTopic(
      connection.db,
      workspace.id,
      lead.id,
      owner.principal,
      {
        title: 'Test-only Pi candidate topic',
        idempotencyKey: `candidate-topic:${randomUUID()}`,
      }
    )
    const messageInput = {
      bodyText: FIXTURE_BODY,
      idempotencyKey: `candidate-message:${randomUUID()}`,
    }
    const bypassKey = `candidate-direct-bypass:${randomUUID()}`
    let configured: Readonly<{ profileId: string; profileVersionId: string }> | undefined
    let admitted: Awaited<ReturnType<typeof createLeadTurn>> | undefined

    const configureProfile = async (
      pin: Readonly<{ profileId: string; profileVersionId: string }>
    ) => {
      requireOpen()
      if (admitted) throw new Error('CANDIDATE_PROFILE_ALREADY_ADMITTED')
      if (!CP_PROFILE.test(pin.profileId) || !CP_PROFILE_VERSION.test(pin.profileVersionId))
        throw new Error('CANDIDATE_CANONICAL_PROFILE_REQUIRED')
      const current = await getWorkspaceLeadForUser(connection.db, workspace.id, owner.principal)
      if (!current || current.id !== lead.id) throw new Error('CANDIDATE_LEAD_UNAVAILABLE')
      const updated =
        current.profile.id === pin.profileId && current.profile.version === pin.profileVersionId
          ? current
          : await changeAgentProfile(connection.db, workspace.id, lead.id, owner.principal, {
              expectedRevision: current.profile.revision,
              profileId: pin.profileId,
              profileVersion: pin.profileVersionId,
              profileState: 'available',
            })
      configured = Object.freeze({ ...pin })
      return updated
    }

    const admit = async () => {
      requireOpen()
      if (!configured) throw new Error('CANDIDATE_PROFILE_CONFIGURATION_REQUIRED')
      const result = await createLeadTurn(
        connection.db,
        workspace.id,
        topic.id,
        owner.principal,
        messageInput
      )
      if (
        admitted &&
        (admitted.message.id !== result.message.id ||
          admitted.leadTurn.intentId !== result.leadTurn.intentId ||
          admitted.leadTurn.dispatchKey !== result.leadTurn.dispatchKey)
      )
        throw new Error('CANDIDATE_CANONICAL_RETRY_IDENTITY_CHANGED')
      admitted = result
      return result
    }

    const currentEvidence = async (
      hostPins: CandidateHostPins,
      options: Readonly<{ includeCanonicalActor?: boolean }> = {}
    ): Promise<CandidateIntentEvidence> => {
      requireOpen()
      validateHostPins(hostPins)
      const accepted = admitted
      const profile = configured
      if (!accepted || !profile) throw new Error('CANDIDATE_CANONICAL_INTENT_REQUIRED')
      if (hostPins.profileVersionId !== profile.profileVersionId)
        throw new Error('CANDIDATE_HOST_PROFILE_MISMATCH')
      return connection.db.transaction(async (tx) => {
        // Nested inspection keeps its live workspace, membership, lead, channel,
        // participant and message locks until this evidence transaction commits.
        const receipt = await getLeadTurnForUser(
          tx,
          workspace.id,
          accepted.message.id,
          owner.principal
        )
        if (!receipt || receipt.intentId !== accepted.leadTurn.intentId)
          throw new Error('CANDIDATE_CURRENT_INTENT_UNAVAILABLE')
        const [canonical] = await tx
          .select({
            intent: leadTurnIntents,
            message: messages,
            workspace: workspaces,
            agent: agents,
          })
          .from(leadTurnIntents)
          .innerJoin(messages, eq(messages.id, leadTurnIntents.messageId))
          .innerJoin(workspaces, eq(workspaces.id, leadTurnIntents.workspaceId))
          .innerJoin(agents, eq(agents.id, leadTurnIntents.agentId))
          .where(
            and(
              eq(leadTurnIntents.id, receipt.intentId),
              eq(leadTurnIntents.workspaceId, workspace.id)
            )
          )
          .for('share')
        if (
          !canonical ||
          canonical.message.bodyText !== FIXTURE_BODY ||
          canonical.message.version !== 1 ||
          canonical.message.editedAt ||
          canonical.message.deletedAt ||
          canonical.message.executionRef ||
          canonical.message.externalSessionRef ||
          canonical.intent.actorUserId !== owner.principal.userId ||
          canonical.message.senderUserId !== owner.principal.userId ||
          canonical.intent.channelId !== topic.id ||
          canonical.intent.agentId !== lead.id ||
          canonical.intent.profileId !== profile.profileId ||
          canonical.intent.profileVersion !== profile.profileVersionId ||
          canonical.agent.profileState !== 'available' ||
          canonical.workspace.controlPlaneWorkspaceId !== workspaceRow.controlPlaneWorkspaceId
        )
          throw new Error('CANDIDATE_CANONICAL_EVIDENCE_CHANGED')
        return Object.freeze({
          schemaVersion: 'pi-lead-intent/v1',
          intentId: canonical.intent.id,
          workspaceId: canonical.workspace.controlPlaneWorkspaceId,
          projectId: null,
          messageRef: `message:${canonical.message.id}`,
          authorityRevision: canonical.intent.channelVersion,
          principalRef: `user:${canonical.intent.actorUserId}`,
          ...(options.includeCanonicalActor
            ? { canonicalActorPrincipalId: `user:${canonical.intent.actorUserId}` }
            : {}),
          scopeRef: `channel:${canonical.intent.channelId}`,
          expiresAt: hostPins.expiresAt,
          allowedPrincipalIds: Object.freeze([hostPins.principalId]),
          selectionRef: hostPins.selectionRef,
          selectionRevision: hostPins.selectionRevision,
          prompt: canonical.message.bodyText,
          profileVersionId: canonical.intent.profileVersion,
          profileContentDigest: hostPins.profileContentDigest,
        })
      })
    }

    const counts = async () => {
      requireOpen()
      const messageId = admitted?.message.id
      const [channelRows] = await connection.db
        .select({ value: count() })
        .from(messages)
        .where(eq(messages.channelId, topic.id))
      const [intentRows] = await connection.db
        .select({ value: count() })
        .from(leadTurnIntents)
        .where(eq(leadTurnIntents.channelId, topic.id))
      if (!messageId)
        return {
          messages: 0,
          intents: intentRows!.value,
          messageCreatedEvents: 0,
          totalChannelMessages: channelRows!.value,
        }
      const [messageRows] = await connection.db
        .select({ value: count() })
        .from(messages)
        .where(eq(messages.id, messageId))
      const [eventRows] = await connection.db
        .select({ value: count() })
        .from(workspaceEvents)
        .where(
          and(
            eq(workspaceEvents.workspaceId, workspace.id),
            eq(workspaceEvents.eventType, 'message.created'),
            sql`${workspaceEvents.payload}->>'messageId' = ${messageId}`
          )
        )
      return {
        messages: messageRows!.value,
        intents: intentRows!.value,
        messageCreatedEvents: eventRows!.value,
        totalChannelMessages: channelRows!.value,
      }
    }

    const verifyDirectSessionBypass = async (externalSessionRef?: string) => {
      requireOpen()
      if (
        externalSessionRef !== undefined &&
        !/^ses_[0-9A-HJKMNP-TV-Z]{26}$/.test(externalSessionRef)
      )
        throw new Error('CANDIDATE_CANONICAL_SESSION_REFERENCE_REQUIRED')
      const message = await createMessage(connection.db, workspace.id, topic.id, owner.principal, {
        sender: owner.principal,
        bodyText: 'Test-only ordinary direct session message',
        idempotencyKey: bypassKey,
        ...(externalSessionRef ? { externalSessionRef } : {}),
      })
      if (await getLeadTurnForUser(connection.db, workspace.id, message.id, owner.principal))
        throw new Error('CANDIDATE_DIRECT_SESSION_INJECTED_LEAD_INTENT')
      return {
        messageId: message.id,
        externalSessionRef: message.externalSessionRef ?? null,
        leadTurn: null,
      }
    }

    return {
      fixtureVersion: 'adea-intent-candidate/v1' as const,
      workspaceId: workspaceRow.controlPlaneWorkspaceId,
      adeaWorkspaceId: workspace.id,
      actorUserId: owner.principal.userId,
      agentId: lead.id,
      channelId: topic.id,
      configureProfile,
      admit,
      retry: admit,
      currentEvidence,
      counts,
      verifyDirectSessionBypass,
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
