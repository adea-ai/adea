import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  createTauriCloudConfig,
  normalizeDesktopCloudOrigin,
} from "../apps/desktop/scripts/tauri-cloud-config.mjs";

const root = new URL("..", import.meta.url).pathname;

describe("desktop packaging and privilege boundary", () => {
  test("packages local frontend assets instead of loading a remote application", async () => {
    const config = JSON.parse(
      await readFile(join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"),
    );
    const main = await readFile(join(root, "apps/desktop/src-tauri/src/main.rs"), "utf8");

    expect(config.build.frontendDist).toBe("../dist");
    expect(config.build.beforeBuildCommand).toBe("bun run shell:client:build");
    expect(
      manifestScript(await readFile(join(root, "apps/desktop/package.json"), "utf8")),
    ).toContain("packages/auth build");
    expect(main).not.toContain("WebviewUrl::External");
    expect(main).not.toContain("AGENT_HQ_WEB_URL");
  });

  test("grants privileged commands only to bundled application code", async () => {
    const capability = JSON.parse(
      await readFile(join(root, "apps/desktop/src-tauri/capabilities/default.json"), "utf8"),
    );

    expect(capability.remote).toBeUndefined();
    expect(capability.local).not.toBe(false);
  });

  test("pins packaged network access to the configured cloud origin", () => {
    const configured = "https://staging.agent-hq.example";
    const csp = createTauriCloudConfig(configured).app.security.csp;

    expect(csp).toContain(`connect-src 'self' ipc: http://ipc.localhost ${configured} `);
    expect(csp).not.toContain("connect-src 'self' https:");
    expect(csp).not.toContain("https://agent-hq-site.vercel.app");
    expect(normalizeDesktopCloudOrigin("http://127.0.0.1:4305")).toBe("http://127.0.0.1:4305");
    expect(() => normalizeDesktopCloudOrigin("https://evil.example/path")).toThrow(
      "Desktop cloud origin",
    );
  });

  test("registers the exact desktop callback scheme and keeps server modules out of the client", async () => {
    const config = JSON.parse(
      await readFile(join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"),
    );
    const manifest = JSON.parse(await readFile(join(root, "apps/desktop/package.json"), "utf8"));
    const client = await readFile(join(root, "apps/desktop/src/main.tsx"), "utf8");

    expect(config.plugins["deep-link"].desktop.schemes).toEqual(["agent-hq"]);
    expect(manifest.dependencies["@agent-hq/auth"]).toBe("workspace:*");
    expect(client).not.toContain("@agent-hq/auth/server");
    expect(client).not.toContain("server-only");
    expect(client).toContain("createDesktopHttpSessionBroker");
    expect(client).toContain("desktop_user_session_save");
  });

  test("provides cloud authorization, exchange, refresh, logout, and revocation handlers", async () => {
    for (const endpoint of ["authorize", "exchange", "refresh", "logout", "revoke"]) {
      const route = await readFile(
        join(root, `apps/web/src/app/api/auth/desktop/${endpoint}/route.ts`),
        "utf8",
      );
      expect(route).toContain('export const runtime = "nodejs"');
      expect(route).toContain('export const dynamic = "force-dynamic"');
    }

    const schema = await readFile(join(root, "packages/db/src/schema/desktop-auth.ts"), "utf8");
    expect(schema).toContain('"code_digest"');
    expect(schema).toContain('"credential_digest"');
    expect(schema).not.toMatch(/text\("(?:code|credential)"\)/u);
  });

  test("keeps provider and server-only modules out of the packaged JavaScript", async () => {
    const assets = join(root, "apps/desktop/dist/assets");
    const scripts = (await readdir(assets)).filter((file) => file.endsWith(".js"));
    expect(scripts.length).toBeGreaterThan(0);
    const bundle = (
      await Promise.all(scripts.map((file) => readFile(join(assets, file), "utf8")))
    ).join("\n");
    expect(bundle).not.toContain("@neondatabase/auth");
    expect(bundle).not.toContain("node:crypto");
    expect(bundle).not.toContain("server-only");
    expect(bundle).not.toContain("@agent-hq/db");
  });
});

function manifestScript(rawManifest: string) {
  const manifest = JSON.parse(rawManifest);
  return manifest.scripts["client:prepare"] as string;
}
