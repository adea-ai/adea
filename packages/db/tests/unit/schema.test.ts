import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";

import {
  agents,
  artifacts,
  authorizationAuditRecords,
  commandOutbox,
  channelParticipants,
  channels,
  contentRefs,
  desktopAuthorizationCodes,
  eventInbox,
  messageArtifactReferences,
  messageMentions,
  messages,
  rooms,
  taskDependencies,
  taskMutations,
  tasks,
  temporaryUserSessions,
  users,
  workspaceMemberships,
  workspaceEvents,
  workspaces,
} from "../../src/schema";

describe("persistence schema", () => {
  test("keeps foundational tables in the app schema", () => {
    for (const table of [
      agents,
      artifacts,
      users,
      temporaryUserSessions,
      workspaces,
      workspaceMemberships,
      authorizationAuditRecords,
      workspaceEvents,
      commandOutbox,
      eventInbox,
      rooms,
      channels,
      contentRefs,
      channelParticipants,
      messages,
      messageMentions,
      messageArtifactReferences,
      tasks,
      taskDependencies,
      taskMutations,
    ]) {
      expect(getTableConfig(table).schema).toBe("app");
    }
  });

  test("keeps Artifact identity, location, and lifecycle workspace scoped", () => {
    const config = getTableConfig(artifacts);
    expect(config.foreignKeys).toHaveLength(3);
    expect(config.uniqueConstraints).toHaveLength(1);
    expect(config.checks.some(({ name }) => name === "artifacts_location_consistent")).toBe(true);
    expect(config.checks.some(({ name }) => name === "artifacts_deletion_consistent")).toBe(true);
    expect(config.indexes.length).toBeGreaterThanOrEqual(4);
  });

  test("keeps product Task state separate from execution and conversation ownership", () => {
    const config = getTableConfig(tasks);
    expect(config.columns.some((column) => column.name === "version")).toBe(true);
    expect(config.columns.some((column) => column.name === "control_plane_execution_ref")).toBe(
      true
    );
    expect(config.columns.some((column) => column.name === "channel_id")).toBe(true);
    expect(config.foreignKeys.map((key) => key.reference().foreignTable)).not.toContain(undefined);
    expect(getTableConfig(taskMutations).uniqueConstraints).toHaveLength(1);
  });

  test("stores only opaque private-content metadata with explicit lifecycle constraints", () => {
    const config = getTableConfig(contentRefs);
    const columns = config.columns.map(({ name }) => name);

    expect(columns).toContain("digest_sha256");
    expect(columns).toContain("synchronization_policy");
    expect(columns).not.toContain("plaintext");
    expect(columns).not.toContain("ciphertext");
    expect(columns).not.toContain("nonce");
    expect(config.checks.some(({ name }) => name === "content_refs_digest_sha256")).toBe(true);
    expect(config.checks.some(({ name }) => name === "content_refs_deletion_consistent")).toBe(
      true
    );
    expect(config.indexes).toHaveLength(3);
  });

  test("represents constraints and indexes in schema metadata", () => {
    const workspaceEventConfig = getTableConfig(workspaceEvents);
    const commandOutboxConfig = getTableConfig(commandOutbox);
    const eventInboxConfig = getTableConfig(eventInbox);

    expect(workspaceEventConfig.foreignKeys).toHaveLength(1);
    expect(workspaceEventConfig.indexes.length).toBeGreaterThan(0);
    expect(commandOutboxConfig.foreignKeys).toHaveLength(1);
    expect(commandOutboxConfig.indexes.length).toBeGreaterThan(0);
    expect(eventInboxConfig.uniqueConstraints.length).toBeGreaterThan(0);
  });

  test("enforces temporary-session and workspace tenancy boundaries", () => {
    const sessionConfig = getTableConfig(temporaryUserSessions);
    const workspaceConfig = getTableConfig(workspaces);
    const membershipConfig = getTableConfig(workspaceMemberships);

    expect(sessionConfig.foreignKeys).toHaveLength(2);
    expect(sessionConfig.checks.some(({ name }) => name.includes("claim_consistent"))).toBe(true);
    expect(
      sessionConfig.uniqueConstraints.some((constraint) =>
        constraint.columns.some((column) => column.name === "credential_digest")
      )
    ).toBe(true);
    expect(workspaceConfig.foreignKeys).toHaveLength(1);
    expect(
      workspaceConfig.uniqueConstraints.some((constraint) =>
        constraint.columns.some((column) => column.name === "idempotency_key")
      )
    ).toBe(true);
    expect(membershipConfig.foreignKeys).toHaveLength(2);
    expect(
      membershipConfig.uniqueConstraints.some(
        (constraint) =>
          constraint.columns.map((column) => column.name).join(":") === "workspace_id:user_id"
      )
    ).toBe(true);
  });

  test("uses a UUID primary key and a unique digest for desktop authorization codes", () => {
    const config = getTableConfig(desktopAuthorizationCodes);

    expect(config.primaryKeys).toHaveLength(0);
    expect(config.columns.find((column) => column.name === "id")?.primary).toBe(true);
    expect(
      config.uniqueConstraints.some((constraint) =>
        constraint.columns.some((column) => column.name === "code_digest")
      )
    ).toBe(true);
  });

  test("keeps room identity workspace scoped without coupling it to channels or scene objects", () => {
    const config = getTableConfig(rooms);

    expect(config.foreignKeys).toHaveLength(1);
    expect(config.foreignKeys[0]?.reference().foreignTable).toBe(workspaces);
    expect(config.columns.some((column) => column.name === "layout_ref")).toBe(true);
    expect(config.columns.some((column) => column.name === "spatial_ref")).toBe(true);
    expect(config.columns.some((column) => column.name === "channel_id")).toBe(false);
  });
});
