import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { createContentRef, getContentRefForUser, updateContentRef } from "../../src/content-refs";
import { createDatabase, type DatabaseConnection } from "../../src/connection";
import { createGroupChannel, createMessage } from "../../src/conversations";
import { createTemporaryUserSession } from "../../src/identity";
import {
  channels,
  contentRefs,
  messages,
  taskMutations,
  tasks,
  temporaryUserSessions,
  users,
  workspaceMemberships,
  workspaces,
} from "../../src/schema";
import { createTask } from "../../src/tasks";
import { createWorkspaceWithOwner } from "../../src/workspaces";

const connectionUrl = process.env.DATABASE_URL;

describe.skipIf(!connectionUrl)("cloud-safe ContentRef metadata", () => {
  let connection: DatabaseConnection;

  beforeAll(() => {
    connection = createDatabase(connectionUrl!);
  });
  afterAll(async () => connection.close());

  test("persists and retries opaque metadata without private plaintext", async () => {
    const canary = "NEVER-PERSIST-PRIVATE-CONTENT";
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: `content-ref-owner-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const outsider = await createTemporaryUserSession(connection.db, {
      credentialDigest: `content-ref-outsider-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `content-ref-${crypto.randomUUID()}`,
      name: "Private Content HQ",
      owner: owner.principal,
    });
    const id = crypto.randomUUID();
    const input = {
      availability: "offline" as const,
      contentType: "task_input" as const,
      digestSha256: "a".repeat(64),
      id,
      keyVersion: 1,
      schemaVersion: 1,
      sensitivity: "restricted" as const,
      storagePolicy: "local_authority" as const,
      synchronizationPolicy: "local_only" as const,
    };

    const created = await createContentRef(connection.db, workspace.id, owner.principal, input);
    const retried = await createContentRef(connection.db, workspace.id, owner.principal, input);
    expect(retried).toEqual(created);
    expect(JSON.stringify(created)).not.toContain(canary);
    expect(
      await getContentRefForUser(connection.db, workspace.id, id, outsider.principal)
    ).toBeNull();

    const updated = await updateContentRef(connection.db, workspace.id, id, owner.principal, {
      availability: "available",
      digestSha256: "b".repeat(64),
      expectedRevision: 1,
      keyVersion: 2,
      revision: 2,
    });
    expect(updated).toMatchObject({ availability: "available", keyVersion: 2, revision: 2 });
    expect(
      await updateContentRef(connection.db, workspace.id, id, owner.principal, {
        availability: "available",
        digestSha256: "b".repeat(64),
        expectedRevision: 1,
        keyVersion: 2,
        revision: 2,
      })
    ).toEqual(updated);

    const persisted = await connection.db.select().from(contentRefs).where(eq(contentRefs.id, id));
    expect(JSON.stringify(persisted)).not.toContain(canary);

    const objectiveContentRefId = crypto.randomUUID();
    await createContentRef(connection.db, workspace.id, owner.principal, {
      ...input,
      availability: "available",
      contentType: "task_objective",
      digestSha256: "c".repeat(64),
      id: objectiveContentRefId,
    });
    const task = await createTask(
      connection.db,
      workspace.id,
      owner.principal,
      { objectiveContentRefId, title: "Private objective task" },
      { idempotencyKey: "private-task", requestId: crypto.randomUUID() }
    );
    expect(task).not.toHaveProperty("objective");
    expect(task.objectiveContentRefId).toBe(objectiveContentRefId);
    expect(
      await createContentRef(connection.db, workspace.id, owner.principal, {
        ...input,
        availability: "missing",
        contentType: "task_objective",
        digestSha256: "c".repeat(64),
        id: objectiveContentRefId,
      })
    ).toMatchObject({ id: objectiveContentRefId, taskId: task.id });

    const channel = await createGroupChannel(connection.db, workspace.id, owner.principal, {
      idempotencyKey: "private-message-channel",
      title: "Private messages",
    });
    const bodyContentRefId = crypto.randomUUID();
    await createContentRef(connection.db, workspace.id, owner.principal, {
      ...input,
      availability: "available",
      contentType: "message_body",
      digestSha256: "d".repeat(64),
      id: bodyContentRefId,
    });
    const message = await createMessage(connection.db, workspace.id, channel.id, owner.principal, {
      bodyContentRefId,
      idempotencyKey: "private-message",
      sender: owner.principal,
    });
    expect(message).not.toHaveProperty("bodyText");
    const neonShaped = await connection.db.transaction(async (transaction) => ({
      contentRefs: await transaction
        .select()
        .from(contentRefs)
        .where(eq(contentRefs.workspaceId, workspace.id)),
      messages: await transaction
        .select()
        .from(messages)
        .where(eq(messages.workspaceId, workspace.id)),
      tasks: await transaction.select().from(tasks).where(eq(tasks.workspaceId, workspace.id)),
    }));
    expect(JSON.stringify(neonShaped)).not.toContain(canary);

    await connection.db.delete(messages).where(eq(messages.workspaceId, workspace.id));
    await connection.db.delete(channels).where(eq(channels.workspaceId, workspace.id));
    await connection.db.delete(taskMutations).where(eq(taskMutations.workspaceId, workspace.id));
    await connection.db.delete(tasks).where(eq(tasks.workspaceId, workspace.id));
    await connection.db.delete(contentRefs).where(eq(contentRefs.workspaceId, workspace.id));
    await connection.db
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, workspace.id));
    await connection.db.delete(workspaces).where(eq(workspaces.id, workspace.id));
    for (const principal of [owner.principal, outsider.principal]) {
      await connection.db
        .delete(temporaryUserSessions)
        .where(eq(temporaryUserSessions.userId, principal.userId));
      await connection.db.delete(users).where(eq(users.id, principal.userId));
    }
  });
});
