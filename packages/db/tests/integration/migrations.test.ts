import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { createDatabase, type DatabaseConnection } from "../../src/connection";
import { appendWorkspaceEvent, inTransaction } from "../../src/transactions";
import {
  commandOutbox,
  users,
  workspaceEvents,
  workspaceMemberships,
  workspaces,
} from "../../src/schema";

const connectionUrl = process.env.DATABASE_URL;

describe.skipIf(!connectionUrl)("PostgreSQL integration", () => {
  let connection: DatabaseConnection;

  beforeAll(() => {
    connection = createDatabase(connectionUrl!);
  });

  afterAll(async () => {
    await connection.close();
  });

  test("commits a domain mutation, WorkspaceEvent, and outbox atomically", async () => {
    const workspaceId = randomUUID();
    const eventId = randomUUID();
    const outboxId = randomUUID();
    const ownerUserId = randomUUID();

    await inTransaction(connection.db, async (transaction) => {
      await transaction.insert(users).values({ id: ownerUserId });
      await transaction.insert(workspaces).values({
        id: workspaceId,
        idempotencyKey: "atomic-create",
        name: "Atomic workspace",
        ownerUserId,
      });
      await transaction.insert(workspaceMemberships).values({
        role: "owner",
        userId: ownerUserId,
        workspaceId,
      });
      await appendWorkspaceEvent(transaction, {
        id: eventId,
        workspaceId,
        eventType: "workspace.created",
        payload: { workspaceId },
      });
      await transaction.insert(commandOutbox).values({
        id: outboxId,
        workspaceId,
        requestId: randomUUID(),
        idempotencyKey: `workspace:${workspaceId}:create`,
        commandType: "workspace.provision",
        payload: { workspaceId },
      });
    });

    expect(
      await connection.db.select().from(workspaceEvents).where(eq(workspaceEvents.id, eventId))
    ).toHaveLength(1);
    expect(
      await connection.db.select().from(commandOutbox).where(eq(commandOutbox.id, outboxId))
    ).toHaveLength(1);

    await connection.db
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, workspaceId));
    await connection.db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await connection.db.delete(users).where(eq(users.id, ownerUserId));
  });

  test("rolls every write back when the transaction fails", async () => {
    const workspaceId = randomUUID();
    const eventId = randomUUID();
    const ownerUserId = randomUUID();

    await expect(
      inTransaction(connection.db, async (transaction) => {
        await transaction.insert(users).values({ id: ownerUserId });
        await transaction.insert(workspaces).values({
          id: workspaceId,
          idempotencyKey: "rollback-create",
          name: "Rollback workspace",
          ownerUserId,
        });
        await appendWorkspaceEvent(transaction, {
          id: eventId,
          workspaceId,
          eventType: "workspace.created",
          payload: { workspaceId },
        });
        throw new Error("rollback marker");
      })
    ).rejects.toThrow("rollback marker");

    expect(
      await connection.db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
    ).toHaveLength(0);
    expect(
      await connection.db.select().from(workspaceEvents).where(eq(workspaceEvents.id, eventId))
    ).toHaveLength(0);
    expect(await connection.db.select().from(users).where(eq(users.id, ownerUserId))).toHaveLength(
      0
    );
  });
});
