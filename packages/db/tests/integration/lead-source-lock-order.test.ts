import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import {
  createDatabase,
  type DatabaseConnection,
  type AgentHqDatabase,
  type AgentHqTransaction,
} from '../../src/connection'
import { createTemporaryUserSession } from '../../src/identity'
import { createWorkspaceWithOwner, reorderWorkspaces } from '../../src/workspaces'
import { ensureWorkspaceLead } from '../../src/agents'
import { createLeadTurn } from '../../src/lead-turns'
import {
  createGroupChannelWithGrants,
  groupCreationCandidatesFromGrants,
  revokeGroupGrant,
} from '../../src/group-channels'
import { withCurrentSourceLeadTurnProduct } from '../../src/lead-source-product'
import { workspaceMemberships, workspaces } from '../../src/schema'

function barrier() {
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, release }
}
function sqlCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const record = error as { code?: string; cause?: unknown }
  return record.code ?? sqlCode(record.cause)
}
const databaseUrl = process.env.DATABASE_URL
describe.skipIf(!databaseUrl)('source lock-order qualification (disposable fixtures only)', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(databaseUrl!)
  })
  afterAll(() => connection.close())
  async function fixture() {
    // Reuse the established canonical test seed pattern, entirely in the owned
    // disposable DB. This provisions no external identity, authority or runtime.
    const actor = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    const spaces = []
    for (const name of ['Lock source A', 'Lock source B']) {
      const created = await createWorkspaceWithOwner(connection.db, {
        name,
        owner: actor.principal,
        idempotencyKey: crypto.randomUUID(),
      })
      const [workspace] = await connection.db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, created.workspace.id))
      spaces.push({
        workspace: workspace!,
        lead: await ensureWorkspaceLead(connection.db, created.workspace.id, actor.principal),
      })
    }
    const groups = []
    for (let index = 0; index < 2; index++) {
      const host = spaces[index]!,
        source = spaces[1 - index]!
      const channelId = crypto.randomUUID(),
        grantId = crypto.randomUUID(),
        issuedAt = new Date(Date.now() - 1_000).toISOString()
      await createGroupChannelWithGrants(connection.db, host.workspace.id, actor.principal, {
        channelId,
        title: 'Lock-order fixture',
        idempotencyKey: crypto.randomUUID(),
        now: issuedAt,
        candidates: groupCreationCandidatesFromGrants(host.workspace.id, {
          audienceGrants: [
            {
              participant: actor.principal,
              groupId: channelId,
              grantId: crypto.randomUUID(),
              revision: 1,
              issuedAt,
              expiresAt: null,
              revokedAt: null,
            },
          ],
          enlistmentGrants: [
            {
              agent: { agentId: source.lead.id, workspaceId: source.workspace.id },
              groupId: channelId,
              grantId,
              revision: 1,
              issuedAt,
              expiresAt: null,
              revokedAt: null,
            },
          ],
        }),
      })
      const admitted = await createLeadTurn(
        connection.db,
        host.workspace.id,
        channelId,
        actor.principal,
        { bodyText: 'Lock qualification only', idempotencyKey: crypto.randomUUID() }
      )
      groups.push({
        host: host.workspace,
        source: source.workspace,
        channelId,
        grantId,
        intentId: admitted.leadTurn.intentId,
      })
    }
    return { actor, spaces, groups }
  }
  function tagged(
    name: string,
    onPid: (pid: number) => void,
    wrap?: (tx: AgentHqTransaction) => AgentHqTransaction,
    lockTimeout = '0'
  ): AgentHqDatabase {
    return new Proxy(connection.db, {
      get(target, key) {
        if (key === 'transaction')
          return (action: (tx: AgentHqTransaction) => Promise<unknown>) =>
            target.transaction(async (tx) => {
              await tx.execute(sql`select set_config('application_name', ${name}, true)`)
              await tx.execute(sql`set local statement_timeout = '4s'`)
              await tx.execute(sql`select set_config('lock_timeout', ${lockTimeout}, true)`)
              const result = await tx.execute(sql`select pg_backend_pid() as pid`)
              onPid(Number(result[0]!.pid))
              return action(wrap ? wrap(tx) : tx)
            })
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }
  async function waitBlocked(pid: number, blocker: number) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const [row] = await connection.client<
        Array<{ blocked: boolean }>
      >`select ${blocker}::int = any(pg_blocking_pids(${pid}::int)) as blocked`
      if (row?.blocked) return
      await Bun.sleep(5)
    }
    throw new Error(`Expected database wait edge ${pid} -> ${blocker}`)
  }
  test('opposite-direction readers retain compatible locks through both awaited verifiers', async () => {
    const f = await fixture(),
      held = barrier(),
      entered = [barrier(), barrier()]
    const reads = f.groups.map((group, index) =>
      withCurrentSourceLeadTurnProduct(
        connection.db,
        group.source.controlPlaneWorkspaceId,
        group.intentId,
        async (product) => {
          entered[index]!.release()
          await held.wait
          return product
        }
      )
    )
    try {
      await Promise.all(entered.map((entry) => entry.wait))
    } finally {
      held.release()
    }
    const products = await Promise.all(reads)
    expect(products[0]!.agentWorkspaceId).toBe(f.groups[0]!.source.id)
    expect(products[1]!.agentWorkspaceId).toBe(f.groups[1]!.source.id)
  })
  test('membership and enlistment revocations wait for final verification, then fresh reads deny', async () => {
    const f = await fixture(),
      group = f.groups[0]!,
      entered = barrier(),
      held = barrier()
    let readerPid = 0,
      memberPid = 0,
      grantPid = 0
    const read = withCurrentSourceLeadTurnProduct(
      tagged('source-lock-reader', (pid) => {
        readerPid = pid
      }),
      group.source.controlPlaneWorkspaceId,
      group.intentId,
      async () => {
        entered.release()
        await held.wait
        return 'linearized-before-revocation'
      }
    )
    await entered.wait
    const membership = tagged('source-lock-membership', (pid) => {
      memberPid = pid
    }).transaction(async (tx) => {
      await tx
        .update(workspaceMemberships)
        .set({ role: 'member' })
        .where(eq(workspaceMemberships.workspaceId, group.source.id))
    })
    const grant = revokeGroupGrant(
      tagged('source-lock-grant', (pid) => {
        grantPid = pid
      }),
      group.host.id,
      group.channelId,
      f.actor.principal,
      { kind: 'enlistment', grantId: group.grantId, revokedAt: new Date().toISOString() }
    )
    try {
      for (let attempt = 0; attempt < 200; attempt++) {
        if (memberPid && grantPid) break
        await Bun.sleep(5)
      }
      expect(memberPid > 0 && grantPid > 0).toBe(true)
      await waitBlocked(memberPid, readerPid)
      await waitBlocked(grantPid, readerPid)
    } finally {
      held.release()
    }
    expect(await read).toBe('linearized-before-revocation')
    await Promise.all([membership, grant])
    await expect(
      withCurrentSourceLeadTurnProduct(
        connection.db,
        group.source.controlPlaneWorkspaceId,
        group.intentId,
        async () => 'must not disclose'
      )
    ).rejects.toThrow('unavailable')
  })
  test.each([{ direction: 0 }, { direction: 1 }])(
    'production source reader does not deadlock with canonical reorder: %j',
    async ({ direction }) => {
      const f = await fixture(),
        group = f.groups[direction]!,
        updatedHost = barrier(),
        continueReorder = barrier()
      let readerPid = 0,
        writerPid = 0,
        updates = 0
      // Pause AFTER the first real membership UPDATE, without changing the
      // canonical reorder's SQL or supplying a substitute writer algorithm.
      const writer = tagged(
        'source-lock-reorder',
        (pid) => {
          writerPid = pid
        },
        (tx) =>
          new Proxy(tx, {
            get(target, key) {
              if (key === 'update')
                return (table: typeof workspaceMemberships) => {
                  const update = target.update(table)
                  return new Proxy(update, {
                    get(builder, property) {
                      if (property === 'set')
                        return (values: Parameters<typeof update.set>[0]) => {
                          const set = builder.set(values)
                          return new Proxy(set, {
                            get(next, final) {
                              if (final === 'where')
                                return (...args: Parameters<typeof set.where>) => {
                                  const query = next.where(...args)
                                  return new Proxy(query, {
                                    get(promise, field) {
                                      if (field === 'then')
                                        return (
                                          resolve: (value: unknown) => unknown,
                                          reject: (error: unknown) => unknown
                                        ) =>
                                          promise
                                            .then(async (value) => {
                                              if (++updates === 1) {
                                                updatedHost.release()
                                                await continueReorder.wait
                                              }
                                              return value
                                            })
                                            .then(resolve, reject)
                                      const value = Reflect.get(promise, field)
                                      return typeof value === 'function'
                                        ? value.bind(promise)
                                        : value
                                    },
                                  })
                                }
                              const value = Reflect.get(next, final)
                              return typeof value === 'function' ? value.bind(next) : value
                            },
                          })
                        }
                      const value = Reflect.get(builder, property)
                      return typeof value === 'function' ? value.bind(builder) : value
                    },
                  })
                }
              const value = Reflect.get(target, key)
              return typeof value === 'function' ? value.bind(target) : value
            },
          })
      )
      const reorder = reorderWorkspaces(writer, f.actor.principal, [
        group.host.id,
        group.source.id,
      ]).then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      )
      await updatedHost.wait
      const readerDb = tagged('source-lock-cycle-reader', (pid) => {
        readerPid = pid
      })
      // The unchanged production reader, no wrapper: it must queue behind the
      // reorder's actor lock instead of holding a membership lock the reorder needs.
      const read = withCurrentSourceLeadTurnProduct(
        readerDb,
        group.source.controlPlaneWorkspaceId,
        group.intentId,
        async () => 'read'
      ).then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      )
      try {
        for (let attempt = 0; attempt < 200; attempt++) {
          if (readerPid) break
          await Bun.sleep(5)
        }
        expect(readerPid).toBeGreaterThan(0)
        await waitBlocked(readerPid, writerPid)
      } finally {
        continueReorder.release()
      }
      const [readResult, reorderResult] = await Promise.all([read, reorder])
      // A 40P01 here is the regression this test exists to catch.
      expect(readResult).toEqual({ value: 'read' })
      expect('error' in reorderResult ? sqlCode(reorderResult.error) : undefined).toBeUndefined()
      expect('value' in reorderResult).toBe(true)
    },
    10_000
  )
  test.each([{ direction: 0 }, { direction: 1 }])(
    'canonical reorder waits behind a reader in final verification, then both finish: %j',
    async ({ direction }) => {
      const f = await fixture(),
        group = f.groups[direction]!,
        entered = barrier(),
        held = barrier()
      let readerPid = 0,
        writerPid = 0
      const read = withCurrentSourceLeadTurnProduct(
        tagged('source-lock-held-reader', (pid) => {
          readerPid = pid
        }),
        group.source.controlPlaneWorkspaceId,
        group.intentId,
        async () => {
          entered.release()
          await held.wait
          return 'read'
        }
      ).then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      )
      await entered.wait
      const reorder = reorderWorkspaces(
        tagged('source-lock-late-reorder', (pid) => {
          writerPid = pid
        }),
        f.actor.principal,
        [group.host.id, group.source.id]
      ).then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      )
      try {
        for (let attempt = 0; attempt < 200; attempt++) {
          if (writerPid) break
          await Bun.sleep(5)
        }
        expect(writerPid).toBeGreaterThan(0)
        await waitBlocked(writerPid, readerPid)
      } finally {
        held.release()
      }
      const [readResult, reorderResult] = await Promise.all([read, reorder])
      expect(readResult).toEqual({ value: 'read' })
      expect('value' in reorderResult).toBe(true)
    },
    10_000
  )
  test('an awaited verifier must not await a revocation that needs its own held grant lock', async () => {
    const f = await fixture(),
      group = f.groups[0]!
    let errorCode: string | undefined
    const product = await withCurrentSourceLeadTurnProduct(
      connection.db,
      group.source.controlPlaneWorkspaceId,
      group.intentId,
      async (current) => {
        // Intentionally forbidden reciprocal callback, bounded by lock_timeout.
        // SQL sees a one-way wait; the return edge is the JavaScript await.
        try {
          await revokeGroupGrant(
            tagged('source-lock-reentrant-verifier', () => {}, undefined, '150ms'),
            group.host.id,
            group.channelId,
            f.actor.principal,
            { kind: 'enlistment', grantId: group.grantId, revokedAt: new Date().toISOString() }
          )
        } catch (error) {
          errorCode = sqlCode(error)
        }
        return current
      }
    )
    expect(errorCode).toBe('55P03')
    expect(product?.enlistmentGrantId).toBe(group.grantId)
  })
})
