import { createHash } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { verifyRegistryArtifacts } from "../../../packages/workspace-ui/src/marketplace-catalog";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = "nextjs-portal { display: none !important; }";
      document.head.append(style);
    });
  });
});

const timestamp = "2026-08-30T12:00:00.000Z";
const workspace = { id: "workspace-e2e", name: "Work", scene: "work", updatedAt: timestamp };
const homeWorkspace = {
  id: "workspace-home-e2e",
  name: "Home",
  scene: "home",
  updatedAt: timestamp,
};
const user = { kind: "user" as const, userId: "user-e2e" };
const agentPrincipal = { kind: "agent" as const, agentId: "agent-research" };

const marketplacePluginSpecs = [
  ["gmail", "Gmail", "productivity", "connector"],
  ["github", "GitHub", "developer-tools", "connector"],
  ["google-drive", "Google Drive", "productivity", "connector"],
  ["google-calendar", "Google Calendar", "productivity", "connector"],
  ["notion", "Notion", "productivity", "connector"],
  ["slack", "Slack", "communication", "connector"],
  ["asana", "Asana", "productivity", "connector"],
  ["trello", "Trello", "productivity", "connector"],
  ["room-summaries", "Room Summaries", "productivity", "skill"],
  ["todoist", "Todoist", "productivity", "connector"],
  ["calendly", "Calendly", "productivity", "connector"],
  ["linear", "Linear", "developer-tools", "connector"],
] as const;

function marketplaceCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(marketplaceCanonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${marketplaceCanonicalJson(object[key])}`)
    .join(",")}}`;
}

function marketplaceDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(marketplaceCanonicalJson(value)).digest("hex")}`;
}

function marketplaceFixture() {
  const plugins = marketplacePluginSpecs.map(([name, displayName, category, kind], index) => {
    const token = (index + 1).toString(16).padStart(2, "0").repeat(32);
    const releaseId = `release:${token}`;
    const release = {
      capabilities: [
        {
          metadata: {},
          name: displayName,
          paths: [],
          securityImpact: "low",
          type: kind === "skill" ? "skill" : "connector",
        },
      ],
      canonicalContentDigest: `sha256:${token}`,
      contentResolution: "complete",
      fileIndex: [],
      pluginSubdirectory: `plugins/${name}`,
      releaseId,
      releaseMetadata: { publishedAt: timestamp },
      requiredConnectors: [],
      requiredCredentials: [],
      resolvedCommitSha: token.slice(0, 40),
      resolvedRepositoryUrl: "https://github.com/adea-ai/plugins",
    };
    return {
      authors: ["Registry fixture"],
      availableReleases: [release],
      capabilitySummary: { [kind]: 1 },
      categories: [category],
      currentReleaseId: releaseId,
      description: `${displayName} registry fixture.`,
      displayName,
      harnessCompatibility: { codex: { status: "portable" } },
      icons: [],
      keywords: [name, category],
      license: { name: "Apache-2.0" },
      pluginId: `plugin:openai-official:${name}`,
      productGroupingKey: name,
      provenance: {
        repositoryUrl: "https://github.com/openai/plugins",
        resolvedCommitSha: token.slice(0, 40),
      },
      securityClassification: { level: "standard" },
      sourceId: "openai-official",
    };
  });
  const body = {
    generatedAt: timestamp,
    plugins,
    schemaVersion: 1,
    sources: [{ repository: "https://github.com/openai/plugins", sourceId: "openai-official" }],
  };
  const catalogId = `catalog:${marketplaceDigest(body).slice("sha256:".length)}`;
  const catalog = { ...body, catalogId };
  const catalogText = JSON.stringify(catalog);
  const summaryText = JSON.stringify({
    catalogId,
    generatedAt: timestamp,
    pluginCount: plugins.length,
    schemaVersion: 1,
  });
  const categoriesText = JSON.stringify({
    categories: [...new Set(plugins.flatMap((plugin) => plugin.categories))],
    catalogId,
    schemaVersion: 1,
  });
  const compatibilityText = JSON.stringify({ catalogId, plugins: [], schemaVersion: 1 });
  const lockText = JSON.stringify({ catalogId, schemaVersion: 1, sources: [] });
  const files = {
    "catalog-summary.v1.json": summaryText,
    "catalog.v1.json": catalogText,
    "categories.v1.json": categoriesText,
    "compatibility.v1.json": compatibilityText,
    "sources.lock.json": lockText,
  };
  const integrityFiles = Object.fromEntries(
    Object.entries(files).map(([name, value]) => [name, marketplaceDigest(value)])
  );
  const artifacts = {
    "catalog-latest.v1.json": catalogText,
    "catalog-summary.v1.json": summaryText,
    "catalog.v1.json": catalogText,
    "categories.v1.json": categoriesText,
    "compatibility.v1.json": compatibilityText,
    "integrity.json": JSON.stringify({ catalogId, files: integrityFiles, schemaVersion: 1 }),
    "sources.lock.json": lockText,
  };
  return { artifacts, catalog, catalogId, plugins };
}
const rooms = [
  {
    createdAt: timestamp,
    functionKey: "product",
    id: "room-product",
    lifecycleState: "active",
    name: "Product",
    sortOrder: 0,
    updatedAt: timestamp,
    workspaceId: workspace.id,
  },
  {
    createdAt: timestamp,
    functionKey: "support",
    id: "room-support",
    lifecycleState: "active",
    name: "Support",
    sortOrder: 1,
    updatedAt: timestamp,
    workspaceId: workspace.id,
  },
];
const agents = [
  {
    createdAt: timestamp,
    id: "agent-research",
    lifecycleState: "active",
    name: "Research Agent",
    presentationMetadata: {},
    profile: { id: "profile-research", state: "available", version: "1" },
    roleSummary: "Customer and market research",
    roomId: "room-product",
    updatedAt: timestamp,
    workspaceId: workspace.id,
  },
  {
    createdAt: timestamp,
    id: "agent-writer",
    lifecycleState: "active",
    name: "Writer Agent",
    presentationMetadata: {},
    profile: { id: "profile-writer", state: "missing", version: "1" },
    roleSummary: "Product copy",
    updatedAt: timestamp,
    workspaceId: workspace.id,
  },
];
const channels = [
  {
    createdAt: timestamp,
    id: "channel-product",
    isPrimaryRoomChannel: true,
    kind: "room",
    lifecycleState: "active",
    participants: [user],
    roomId: "room-product",
    sortOrder: 0,
    title: "Product",
    updatedAt: timestamp,
    version: 1,
    visibility: "workspace",
    workspaceId: workspace.id,
  },
  {
    createdAt: timestamp,
    id: "channel-support",
    isPrimaryRoomChannel: true,
    kind: "room",
    lifecycleState: "active",
    participants: [user],
    roomId: "room-support",
    sortOrder: 0,
    title: "Support",
    updatedAt: timestamp,
    version: 1,
    visibility: "workspace",
    workspaceId: workspace.id,
  },
  {
    agentId: "agent-research",
    createdAt: timestamp,
    id: "channel-agent",
    isPrimaryRoomChannel: false,
    kind: "direct_agent",
    lifecycleState: "active",
    participants: [user, agentPrincipal],
    sortOrder: 2,
    title: "Research Agent",
    updatedAt: timestamp,
    version: 1,
    visibility: "participants",
    workspaceId: workspace.id,
  },
  {
    createdAt: timestamp,
    id: "channel-group",
    isPrimaryRoomChannel: false,
    kind: "group",
    lifecycleState: "active",
    participants: [user, agentPrincipal],
    sortOrder: 3,
    title: "Launch group",
    updatedAt: timestamp,
    version: 1,
    visibility: "participants",
    workspaceId: workspace.id,
  },
];
const tasks = [
  {
    agentId: "agent-research",
    artifactRefs: ["artifact-brief"],
    conversation: { channelId: "channel-product", messageId: "message-task" },
    createdAt: timestamp,
    creator: user,
    dependencyIds: [],
    id: "task-launch",
    lifecycleState: "created",
    objective: "Prepare the launch brief and confirm audience.",
    priority: "high",
    roomId: "room-product",
    title: "Launch planning",
    updatedAt: timestamp,
    version: 1,
    workspaceId: workspace.id,
  },
  {
    artifactRefs: [],
    conversation: {},
    createdAt: timestamp,
    creator: user,
    dependencyIds: ["task-launch"],
    id: "task-review",
    lifecycleState: "queued",
    objective: "Review the customer-facing plan.",
    priority: "normal",
    title: "Review launch",
    updatedAt: timestamp,
    version: 2,
    workspaceId: workspace.id,
  },
];
const artifacts = [
  {
    availability: "available",
    checksumSha256: "a".repeat(64),
    createdAt: timestamp,
    deletionState: "active",
    filename: "launch-brief.md",
    id: "artifact-brief",
    location: { reference: "artifact://launch-brief", type: "object_store" },
    mediaType: "text/markdown",
    owner: user,
    provenance: { source: "e2e" },
    retentionPolicy: "standard",
    sensitivity: "workspace",
    sizeBytes: 2048,
    sourceArtifactRef: "artifact://launch-brief",
    sourcePrincipal: user,
    taskId: "task-launch",
    updatedAt: timestamp,
    version: 1,
    workspaceId: workspace.id,
  },
];
const messages = [
  {
    artifactIds: [],
    bodyText: "Welcome to the Product Room. This is durable workspace history.",
    channelId: "channel-product",
    createdAt: timestamp,
    deleted: false,
    id: "message-root",
    mentions: [],
    sender: { kind: "system", systemId: "agent-hq" },
    sequence: 1,
    updatedAt: timestamp,
    version: 1,
    workspaceId: workspace.id,
  },
  {
    artifactIds: ["artifact-brief"],
    bodyText: "The launch brief is ready for review. @Research Agent",
    channelId: "channel-product",
    createdAt: timestamp,
    deleted: false,
    id: "message-task",
    mentions: [agentPrincipal],
    sender: user,
    sequence: 2,
    taskId: "task-launch",
    updatedAt: timestamp,
    version: 1,
    workspaceId: workspace.id,
  },
  {
    artifactIds: [],
    bodyContentRefId: "content-private",
    channelId: "channel-product",
    createdAt: timestamp,
    deleted: false,
    id: "message-private",
    mentions: [],
    sender: agentPrincipal,
    sequence: 3,
    updatedAt: timestamp,
    version: 1,
    workspaceId: workspace.id,
  },
];
const reply = {
  artifactIds: [],
  bodyText: "I will add competitor evidence here.",
  channelId: "channel-product",
  createdAt: timestamp,
  deleted: false,
  id: "message-reply",
  mentions: [],
  replyToMessageId: "message-root",
  sender: agentPrincipal,
  sequence: 4,
  threadRootMessageId: "message-root",
  updatedAt: timestamp,
  version: 1,
  workspaceId: workspace.id,
};
const readState = [
  {
    channelId: "channel-product",
    lastReadSequence: 0,
    latestTopLevelSequence: 3,
    manuallyUnread: false,
    threadUnreadCount: 1,
    threads: [
      {
        lastReadSequence: 0,
        latestSequence: 4,
        manuallyUnread: false,
        threadRootMessageId: "message-root",
        unreadCount: 1,
      },
    ],
    topLevelUnreadCount: 3,
    unread: true,
    workspaceId: workspace.id,
  },
];

async function mockWorkspace(page: Page, empty = false) {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("agent-hq:e2e-initialized")) {
      localStorage.clear();
      localStorage.setItem("theme", "light");
      sessionStorage.setItem("agent-hq:e2e-initialized", "true");
    }
  });
  await page.route("**/api/workspaces/bootstrap", (route) =>
    route.fulfill({
      contentType: "application/json",
      json: { activeWorkspace: workspace, principal: { temporary: true }, workspaces: [workspace] },
    })
  );
  await page.route("**/api/v1/workspaces/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes("/read-state"))
      return route.fulfill({ contentType: "application/json", json: { readState } });
    if (
      url.pathname.includes("/agents/agent-research/") &&
      ["PATCH", "POST"].includes(route.request().method())
    ) {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      const updated = {
        ...agents[0],
        ...(url.pathname.endsWith("/presentation") ? body : {}),
        ...(url.pathname.endsWith("/room") ? { roomId: body.roomId } : {}),
        ...(url.pathname.endsWith("/profile")
          ? {
              profile: {
                id: body.profileId,
                state: body.profileState ?? "available",
                version: body.profileVersion,
              },
            }
          : {}),
      };
      return route.fulfill({ contentType: "application/json", json: { agent: updated } });
    }
    if (url.pathname.endsWith("/agents/agent-research") && route.request().method() === "DELETE")
      return route.fulfill({ contentType: "application/json", json: { archived: true } });
    if (route.request().method() !== "GET")
      return route.fulfill({ contentType: "application/json", json: {} });
    if (url.pathname.endsWith("/search")) {
      const query = url.searchParams.get("q")?.toLocaleLowerCase() ?? "";
      const results = query.includes("brief")
        ? [
            {
              id: "artifact-brief",
              kind: "artifact",
              label: "launch-brief.md",
              secondary: "text/markdown",
              taskId: "task-launch",
              workspaceId: workspace.id,
            },
          ]
        : query.includes("durable")
          ? [
              {
                channelId: "channel-product",
                id: "message-root",
                kind: "message",
                label: "This is durable workspace history.",
                messageId: "message-root",
                roomId: "room-product",
                secondary: "Product · Message",
                workspaceId: workspace.id,
              },
            ]
          : [];
      return route.fulfill({
        contentType: "application/json",
        json: { privateResultsUnavailable: true, results },
      });
    }
    if (url.pathname.endsWith("@adea-ai/rooms"))
      return route.fulfill({ contentType: "application/json", json: empty ? [] : rooms });
    if (url.pathname.endsWith("/agents"))
      return route.fulfill({ contentType: "application/json", json: empty ? [] : agents });
    if (url.pathname.endsWith("/tasks"))
      return route.fulfill({ contentType: "application/json", json: empty ? [] : tasks });
    if (url.pathname.endsWith("/artifacts"))
      return route.fulfill({ contentType: "application/json", json: empty ? [] : artifacts });
    if (url.pathname.endsWith("/channels"))
      return route.fulfill({ contentType: "application/json", json: empty ? [] : channels });
    if (url.pathname.endsWith("/messages")) {
      const channelId = url.pathname.split("/").at(-2);
      const threadRoot = url.searchParams.get("threadRootMessageId");
      const channelMessages = empty
        ? []
        : channelId === "channel-product"
          ? messages
          : [
              {
                ...messages[0],
                bodyText:
                  channelId === "channel-agent"
                    ? "Private planning with Research Agent."
                    : "Launch group coordination.",
                channelId,
                id: `message-${channelId}`,
              },
            ];
      return route.fulfill({
        contentType: "application/json",
        json: { messages: threadRoot ? [reply] : channelMessages, nextAfterSequence: null },
      });
    }
    return route.fulfill({ contentType: "application/json", json: {} });
  });
}

async function mockConnectedWorkspace(page: Page) {
  const mutableRooms = rooms.map((room) => ({ ...room }));
  const mutableChannels = channels.map((channel) => ({ ...channel }));

  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("theme", "light");
  });
  await page.route("**/api/workspaces/bootstrap", (route) =>
    route.fulfill({
      contentType: "application/json",
      json: {
        activeWorkspace: workspace,
        principal: { temporary: true, userId: "user-e2e" },
        workspaces: [workspace, homeWorkspace],
      },
    })
  );
  await page.route("**/api/v1/workspaces/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname.endsWith("@adea-ai/rooms")) {
      const body = request.postDataJSON() as { functionKey: string; name: string };
      const createdRoom = {
        createdAt: timestamp,
        functionKey: body.functionKey,
        id: "room-created",
        lifecycleState: "active" as const,
        name: body.name,
        sortOrder: mutableRooms.length,
        updatedAt: timestamp,
        workspaceId: workspace.id,
      };
      mutableRooms.push(createdRoom);
      mutableChannels.push({
        createdAt: timestamp,
        id: "channel-created-room",
        isPrimaryRoomChannel: true,
        kind: "room",
        lifecycleState: "active",
        participants: [user],
        roomId: createdRoom.id,
        sortOrder: 0,
        title: createdRoom.name,
        updatedAt: timestamp,
        version: 1,
        visibility: "workspace",
        workspaceId: workspace.id,
      });
      return route.fulfill({
        contentType: "application/json",
        json: { room: createdRoom },
        status: 201,
      });
    }
    if (request.method() === "POST" && url.pathname.endsWith("/channels")) {
      const body = request.postDataJSON() as { agentId?: string; kind: string; title: string };
      if (body.kind === "direct_agent") {
        const directChannel = mutableChannels.find(
          (channel) => channel.kind === "direct_agent" && channel.agentId === body.agentId
        );
        return route.fulfill({
          contentType: "application/json",
          json: { channel: directChannel },
          status: 201,
        });
      }
      const createdChannel = {
        createdAt: timestamp,
        id: "channel-created-group",
        isPrimaryRoomChannel: false,
        kind: body.kind as "group",
        lifecycleState: "active" as const,
        participants: [user],
        sortOrder: mutableChannels.length,
        title: body.title,
        updatedAt: timestamp,
        version: 1,
        visibility: "participants" as const,
        workspaceId: workspace.id,
      };
      mutableChannels.push(createdChannel);
      return route.fulfill({
        contentType: "application/json",
        json: { channel: createdChannel },
        status: 201,
      });
    }
    if (request.method() !== "GET")
      return route.fulfill({ contentType: "application/json", json: {} });
    if (url.pathname.includes("/read-state"))
      return route.fulfill({ contentType: "application/json", json: { readState } });
    if (url.pathname.endsWith("@adea-ai/rooms"))
      return route.fulfill({ contentType: "application/json", json: mutableRooms });
    if (url.pathname.endsWith("/channels"))
      return route.fulfill({ contentType: "application/json", json: mutableChannels });
    if (url.pathname.endsWith("/agents"))
      return route.fulfill({ contentType: "application/json", json: agents });
    if (url.pathname.endsWith("/tasks"))
      return route.fulfill({ contentType: "application/json", json: tasks });
    if (url.pathname.endsWith("/artifacts"))
      return route.fulfill({ contentType: "application/json", json: artifacts });
    if (url.pathname.endsWith("/messages"))
      return route.fulfill({ contentType: "application/json", json: { messages: [] } });
    return route.fulfill({ contentType: "application/json", json: {} });
  });
}

test("renders empty and populated Room-first workspace states", async ({ page }) => {
  await mockWorkspace(page, true);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Rooms" })).toBeVisible();
  await expect(page.getByText("Create a Room to organize the work.")).toBeVisible();
  await expect(page).toHaveScreenshot("workspace-empty-light.png", { animations: "disabled" });

  await page.unrouteAll({ behavior: "wait" });
  await mockWorkspace(page);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Product", exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Private content unavailable")).toBeVisible();
  await expect(page.getByLabel("Attachment launch-brief.md")).toBeVisible();
  await expect(page).toHaveScreenshot("workspace-room-populated-light.png", {
    animations: "disabled",
  });
});

test("centers creation dialogs in the viewport", async ({ page }) => {
  await mockConnectedWorkspace(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Rooms" })).toBeVisible();
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1280, height: 720 },
  ]) {
    await page.setViewportSize(viewport);
    const openNavigation = page.getByRole("button", { name: "Open workspace navigation" });
    if (await openNavigation.isVisible()) await openNavigation.click();
    await page
      .getByRole("complementary", { name: "Workspace navigation" })
      .getByRole("button", { name: "Create Room", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Create Room" });
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.abs(box!.x + box!.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(2);
    expect(Math.abs(box!.y + box!.height / 2 - viewport.height / 2)).toBeLessThanOrEqual(2);
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
  }
});

test("uses the neutral shadcn semantic theme by default", async ({ page }) => {
  await mockConnectedWorkspace(page);
  await page.goto("/");
  const tokens = await page.evaluate(() => {
    const styles = getComputedStyle(document.documentElement);
    return {
      background: styles.getPropertyValue("--background").trim(),
      primary: styles.getPropertyValue("--primary").trim(),
    };
  });
  expect(tokens.background).toMatch(/^oklch\((?:1|100%) 0 0\)$/);
  expect(tokens.primary).toMatch(/^oklch\((?:0\.205|20\.5%) 0 0\)$/);
});

test("loads chat before secure-context-only authentication APIs are requested", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window.crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    });
  });
  await mockConnectedWorkspace(page);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Rooms" })).toBeVisible();
});

test("connects newly created Rooms and group conversations to their canonical views", async ({
  page,
}) => {
  await mockConnectedWorkspace(page);
  await page.goto("/");

  await page.getByRole("button", { name: "Create Room", exact: true }).last().click();
  const roomDialog = page.getByRole("dialog", { name: "Create Room" });
  await roomDialog.getByLabel("Room name").fill("Runtime Review");
  await roomDialog.getByLabel("Function key").fill("runtime-review");
  await roomDialog.getByRole("button", { name: "Create Room", exact: true }).click();
  await expect(
    page.locator("#workspace-main").getByRole("heading", { name: "Runtime Review", exact: true })
  ).toBeVisible();

  await page.getByRole("button", { name: "Create group conversation" }).click();
  const groupDialog = page.getByRole("dialog", { name: "New group conversation" });
  await groupDialog.getByLabel("Conversation name").fill("Connected review");
  await groupDialog.getByRole("button", { name: "Create conversation" }).click();
  await expect(
    page.locator("#workspace-main").getByRole("heading", { name: "Connected review", exact: true })
  ).toBeVisible();

  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: "Open conversation" }).first().click();
  await expect(
    page.locator("#workspace-main").getByRole("heading", { name: "Research Agent", exact: true })
  ).toBeVisible();
});

test("toggles chat and virtual Room views without losing shared selection or drafts", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await mockConnectedWorkspace(page);
  await page.goto("/");
  const globalNavigation = page.getByRole("navigation", { name: "Global navigation" });
  await expect(globalNavigation).toBeVisible();
  await expect(globalNavigation.getByText("⌘ K")).toBeVisible();
  await expect(
    globalNavigation.getByRole("button", { name: "Notifications (coming soon)" })
  ).toBeDisabled();
  await expect(
    globalNavigation.getByRole("button", { name: "Switch workspace, current Work" })
  ).toBeVisible();
  await expect(globalNavigation.getByRole("button", { name: "Home workspace" })).toHaveCount(0);
  await expect(globalNavigation.getByRole("button", { name: "Work workspace" })).toHaveCount(0);
  await expect(page.locator("#workspace-switcher")).toHaveCount(0);
  await expect(page.locator(".conventional-topbar")).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "Workspace navigation" })).toBeVisible();
  await page.getByRole("button", { name: /^Product Room/ }).click();
  await page.getByRole("textbox", { name: "Message" }).fill("Keep this connected draft.");

  await globalNavigation.getByRole("button", { name: "Switch workspace, current Work" }).click();
  await expect(page).toHaveScreenshot("workspace-switcher.png", { animations: "disabled" });
  await expect(page.getByText("Scenes", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitemradio", { name: /Home/ })).toBeVisible();
  await expect(page.getByRole("menuitemradio", { name: /Work/ })).toBeVisible();
  await page.getByRole("menuitemradio", { name: /Home/ }).click();
  await expect(
    globalNavigation.getByRole("button", { name: "Switch workspace, current Home" })
  ).toBeVisible();
  await expect(page).toHaveURL(/scene=home/);
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("");

  await globalNavigation.getByRole("button", { name: "Switch workspace, current Home" }).click();
  await page.getByRole("menuitemradio", { name: /Work/ }).click();
  await expect(page).toHaveURL(/scene=work/);
  await expect(
    globalNavigation.getByRole("button", { name: "Switch workspace, current Work" })
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("");
  await page.getByRole("textbox", { name: "Message" }).fill("Keep this connected draft.");

  await globalNavigation.getByRole("button", { name: "Virtual view" }).click();
  await expect(page).toHaveURL(/view=virtual/);
  await expect(page.getByRole("region", { name: "Virtual Room" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("complementary", { name: "Workspace navigation" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Product", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true"
  );

  await globalNavigation.getByRole("button", { name: "Chat view" }).click();
  await expect(page).toHaveURL(/view=chat/);
  await expect(
    page.locator("#workspace-main").getByRole("heading", { name: "Product", exact: true })
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue(
    "Keep this connected draft."
  );
});

test("keeps Plugins unavailable until workspace bootstrap completes", async ({ page }) => {
  let releaseBootstrap!: () => void;
  const bootstrapBlocked = new Promise<void>((resolve) => {
    releaseBootstrap = resolve;
  });
  await page.route("**/api/workspaces/bootstrap", async (route) => {
    await bootstrapBlocked;
    await route.fulfill({
      contentType: "application/json",
      json: {
        activeWorkspace: workspace,
        principal: { temporary: true, userId: "user-e2e" },
        workspaces: [workspace, homeWorkspace],
      },
    });
  });
  await page.goto("/?view=chat");
  const globalNavigation = page.getByRole("navigation", { name: "Global navigation" });
  const pluginsButton = globalNavigation.getByRole("button", { name: "Plugins" });
  await expect(pluginsButton).toBeVisible();
  await expect(pluginsButton).toBeDisabled();

  releaseBootstrap();
  await expect(pluginsButton).toBeEnabled();
});

test("browses the verified registry marketplace and submits an exact install request", async ({
  page,
}) => {
  await mockConnectedWorkspace(page);
  const fixture = marketplaceFixture();
  await expect(verifyRegistryArtifacts(fixture.artifacts)).resolves.toBeTruthy();
  const installRequests: unknown[] = [];
  await page.route("**/api/marketplace/catalog", (route) =>
    route.fulfill({
      contentType: "application/json",
      json: {
        artifacts: fixture.artifacts,
        catalogId: fixture.catalogId,
        installations: [],
        releaseId: fixture.catalogId,
        state: "ready",
      },
    })
  );
  await page.route("**/api/marketplace/install", async (route) => {
    const request = route.request().postDataJSON() as {
      canonicalContentDigest: string;
      idempotencyKey: string;
      pluginId: string;
      releaseId: string;
      requestedHarness: string;
    };
    installRequests.push(request);
    await route.fulfill({
      contentType: "application/json",
      json: {
        canonicalContentDigest: request.canonicalContentDigest,
        installationId: "ins_e2e-marketplace",
        message: "Authorization is required before installation.",
        pluginId: request.pluginId,
        releaseId: request.releaseId,
        state: "pending-authorization",
      },
    });
  });
  await page.goto("/?view=chat");
  const globalNavigation = page.getByRole("navigation", { name: "Global navigation" });
  await globalNavigation.getByRole("button", { name: "Plugins" }).click();
  const plugins = page.getByRole("dialog", { name: "Plugins" });
  await expect(plugins).toBeVisible();
  await expect(plugins.locator(".plugins-browser__count")).toHaveText(/^\d+ plugins$/);

  const pluginGroups = plugins.locator(".plugins-browser__group");
  const popularPlugins = pluginGroups.first();
  await expect(popularPlugins.getByRole("heading", { name: "Popular" })).toBeVisible();
  await expect(popularPlugins.locator(".plugins-browser__row")).toHaveCount(6);
  await expect(popularPlugins.getByRole("button", { name: /Gmail/ })).toBeVisible();
  await expect(popularPlugins.getByRole("button", { name: /GitHub/ })).toBeVisible();
  expect(
    await pluginGroups
      .locator(".plugins-browser__grid")
      .evaluateAll((grids) =>
        grids.every((grid) => grid.querySelectorAll(".plugins-browser__row").length <= 6)
      )
  ).toBe(true);

  const productivityPlugins = pluginGroups.filter({
    has: page.getByRole("heading", { name: "Productivity", exact: true }),
  });
  await plugins.getByRole("button", { name: "See Room Summaries, Todoist and more" }).click();
  await expect(productivityPlugins.locator(".plugins-browser__row")).toHaveCount(9);
  await productivityPlugins.getByRole("button", { name: "Show less" }).click();
  await expect(productivityPlugins.locator(".plugins-browser__row")).toHaveCount(6);

  await plugins.getByRole("searchbox", { name: "Search plugins" }).fill("github");
  await plugins.getByRole("button", { name: /GitHub/ }).click();
  await expect(plugins.getByRole("heading", { name: "GitHub" })).toBeVisible();
  await expect(plugins.getByText("openai-official", { exact: true })).toBeVisible();
  await expect(plugins.getByText("MCP", { exact: true })).toBeVisible();
  await plugins.getByRole("button", { name: "Add", exact: true }).click();
  await expect(
    plugins.getByRole("button", { name: "Authorization pending", exact: true })
  ).toBeVisible();
  expect(installRequests).toEqual([
    {
      canonicalContentDigest: `sha256:${"02".repeat(32)}`,
      idempotencyKey: `marketplace:plugin:openai-official:github:release:${"02".repeat(32)}`,
      pluginId: "plugin:openai-official:github",
      releaseId: `release:${"02".repeat(32)}`,
      requestedHarness: "codex",
    },
  ]);
  expect(
    await page.evaluate(() => Object.keys(localStorage).filter((key) => /plugin/i.test(key)))
  ).toEqual([]);
  await plugins.getByRole("button", { name: "Back to plugins" }).click();
  await plugins.getByRole("tab", { name: "Yours" }).click();
  await expect(plugins.getByText("No plugins added yet")).toBeVisible();
});

test("navigates direct, group, thread, and Task detail surfaces", async ({ page }) => {
  await mockWorkspace(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Research Agent", exact: true }).click();
  await expect(page.getByText("Direct Agent", { exact: true })).toBeVisible();
  await expect(page).toHaveScreenshot("workspace-direct-agent.png", { animations: "disabled" });

  await page.getByRole("button", { name: "Launch group", exact: true }).click();
  await expect(
    page.locator("#workspace-main").getByText("Group conversation", { exact: true })
  ).toBeVisible();
  await expect(page).toHaveScreenshot("workspace-group.png", { animations: "disabled" });

  await page.getByRole("button", { name: /^Product Room/ }).click();
  await page.getByRole("button", { name: "Thread", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Thread" })).toBeVisible();
  await expect(page.getByText("I will add competitor evidence here.")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => ({
        documentScroll: document.documentElement.scrollLeft,
        workspaceScroll: document.querySelector(".conventional-workspace")?.scrollLeft ?? -1,
      }))
    )
    .toEqual({ documentScroll: 0, workspaceScroll: 0 });
  await expect(page).toHaveScreenshot("workspace-thread.png", { animations: "disabled" });
  await page.getByRole("button", { name: "Close thread" }).click();

  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await page.getByRole("button", { name: /Launch planning/ }).click();
  await expect(page.getByRole("heading", { name: "Launch planning" })).toBeVisible();
  await expect(page).toHaveScreenshot("workspace-task-detail.png", { animations: "disabled" });
});

test("supports narrow navigation, keyboard search, and dark mode", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockWorkspace(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Open workspace navigation" })).toBeVisible();
  await page.getByRole("button", { name: "Open workspace navigation" }).click();
  const navigation = page.getByRole("complementary", { name: "Workspace navigation" });
  await expect(navigation).toBeVisible();
  await expect(page).toHaveScreenshot("workspace-narrow-light.png", { animations: "disabled" });
  await navigation.getByRole("button", { name: "Close workspace navigation" }).click();

  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Search workspace" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Search workspace" })).not.toBeVisible();

  await page.evaluate(() => {
    localStorage.setItem("theme", "dark");
    document.documentElement.classList.remove("light");
    document.documentElement.classList.add("dark");
  });
  await expect(page).toHaveScreenshot("workspace-narrow-dark.png", { animations: "disabled" });
});

test("operates unread actions and deep-linked search entirely by keyboard", async ({ page }) => {
  await mockWorkspace(page);
  await page.goto("/");
  await expect(page.getByLabel(/unread in Product/)).toBeVisible({ timeout: 15_000 });

  await page.keyboard.press("Control+k");
  const globalSearch = page.getByRole("dialog", { name: "Search workspace" });
  await globalSearch.getByRole("textbox").fill("launch brief");
  await expect(globalSearch.getByRole("option", { name: /launch-brief\.md/ })).toBeVisible();
  await expect(globalSearch.getByRole("textbox")).toBeFocused();
  await expect(globalSearch.getByRole("option", { name: /launch-brief\.md/ })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "launch-brief.md" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.keyboard.press("Control+f");
  const conversationSearch = page.getByRole("dialog", { name: "Search this conversation" });
  await conversationSearch.getByRole("textbox").fill("durable");
  await expect(conversationSearch.getByRole("option", { name: /durable workspace/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-message-id="message-root"]')).toHaveClass(/highlighted/);

  const unreadRequest = page.waitForRequest((request) =>
    request.url().includes("/read-state/channels/channel-product")
  );
  await page.keyboard.press("Control+Shift+u");
  expect((await unreadRequest).postDataJSON()).toEqual({ action: "unread" });
});

test("retains drafts across navigation and reloads at supported breakpoints", async ({ page }) => {
  await mockWorkspace(page);
  await page.goto("/");
  const draft = "Evidence to preserve while I check another conversation.";
  await page.getByRole("textbox", { name: "Message" }).fill(draft);
  await page.getByRole("button", { name: "Research Agent", exact: true }).click();
  await page.getByRole("button", { name: /^Product Room/ }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue(draft);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue(draft);

  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(page.locator(".conventional-workspace")).toBeVisible();
    const viewport = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }));
    expect(viewport.documentWidth).toBe(viewport.viewportWidth);
  }
});

test("deep-links settings and customizes an Agent without fabricating runtime status", async ({
  page,
}) => {
  await mockWorkspace(page);
  await page.goto("/#settings/privacy-data");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("heading", { name: "Privacy & data" })).toBeVisible();
  await expect(settings.getByText("Unavailable in this app or on this device.")).toBeVisible();

  await settings.getByRole("tab", { name: "Input & notifications" }).click();
  await expect(settings.getByRole("button", { name: "Check microphone" })).toBeDisabled();
  await settings.getByRole("switch", { name: "Mention notifications" }).uncheck();
  await expect(page).toHaveScreenshot("workspace-settings-light.png", { animations: "disabled" });
  await page.evaluate(() => {
    localStorage.setItem("theme", "dark");
    document.documentElement.classList.remove("light");
    document.documentElement.classList.add("dark");
  });
  await expect(page).toHaveScreenshot("workspace-settings-dark.png", { animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page).toHaveScreenshot("workspace-settings-narrow.png", { animations: "disabled" });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth === window.innerWidth)
  ).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => {
    localStorage.setItem("theme", "light");
    document.documentElement.classList.remove("dark");
    document.documentElement.classList.add("light");
  });

  await settings.getByRole("tab", { name: "Agents" }).focus();
  await page.keyboard.press("End");
  await expect(settings.getByRole("tab", { name: "Integrations & capabilities" })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(settings.getByRole("tab", { name: "Account & app" })).toBeFocused();
  await settings.getByRole("tab", { name: "Agents" }).click();
  await settings.getByRole("button", { name: "Customize Agents" }).click();

  const configured = page.getByText("Configured", { exact: true }).first();
  await expect(configured).toBeVisible();
  await expect(page.getByText("Runtime unknown", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Activity unknown", { exact: true }).first()).toBeVisible();
  expect((await page.locator(".conventional-agent-card").allTextContents()).join(" ")).not.toMatch(
    /online|working/i
  );

  await page.getByRole("button", { name: "Customize", exact: true }).first().click();
  const form = page.locator("form.conventional-agent-customization");
  await form.getByLabel("Name").fill("Research Lead");
  await form.getByLabel("Role or persona").fill("Market evidence and customer research");
  await form.getByLabel("Room").selectOption("room-support");
  await form.getByLabel("AgentProfile version").fill("2");
  const presentation = page.waitForRequest((request) => request.url().endsWith("/presentation"));
  const room = page.waitForRequest((request) => request.url().endsWith("/room"));
  const profile = page.waitForRequest((request) => request.url().endsWith("/profile"));
  await form.getByRole("button", { name: "Save changes" }).click();
  expect((await presentation).postDataJSON()).toMatchObject({ name: "Research Lead" });
  expect((await room).postDataJSON()).toEqual({ roomId: "room-support" });
  expect((await profile).postDataJSON()).toMatchObject({
    profileId: "profile-research",
    profileVersion: "2",
  });

  await page.getByRole("button", { name: "Customize", exact: true }).first().click();
  await expect(page.getByText("Permanent deletion is unavailable")).toBeVisible();
  await page.getByRole("button", { name: "Archive Agent" }).click();
  await expect(page.getByRole("alertdialog", { name: "Archive Research Agent" })).toBeVisible();
  await expect(page).toHaveScreenshot("workspace-agent-customization.png", {
    animations: "disabled",
  });
});
