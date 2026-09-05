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
      await readFile(join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8")
    );
    const main = await readFile(join(root, "apps/desktop/src-tauri/src/main.rs"), "utf8");

    expect(config.build.frontendDist).toBe("../dist");
    expect(config.build.beforeBuildCommand).toBe("bun run shell:client:build");
    const prepareScript = manifestScript(
      await readFile(join(root, "apps/desktop/package.json"), "utf8")
    );
    expect(prepareScript).toContain("turbo run build --filter=@agent-hq/desktop^...");
    expect(prepareScript).not.toContain("scenes/hq build");
    expect(main).not.toContain("WebviewUrl::External");
    expect(main).not.toContain("AGENT_HQ_WEB_URL");
  });

  test("enters the bundled spatial workspace after guest bootstrap", async () => {
    const manifest = JSON.parse(await readFile(join(root, "apps/desktop/package.json"), "utf8"));
    const client = await readFile(join(root, "apps/desktop/src/main.tsx"), "utf8");
    const workspace = await readFile(join(root, "apps/desktop/src/desktop-workspace.tsx"), "utf8");

    expect(manifest.dependencies["@agent-hq/hq-scenes"]).toBe("workspace:*");
    expect(client).toContain("<DesktopWorkspace");
    expect(client).toContain("if (workspaceState)");
    expect(client).toContain("setSession(activeSession)");
    expect(client).toContain("<GlobalWorkspaceRail");
    expect(workspace).toContain("<HqRoomScene");
    expect(workspace).toContain('aria-label="Agent HQ workspace controls"');
    expect(workspace).toContain("showAccountDrawer={false}");
    expect(client).toContain("Try again");
  });

  test("keeps desktop scene controls inside the canvas group without a status bar", async () => {
    const workspace = await readFile(join(root, "apps/desktop/src/desktop-workspace.tsx"), "utf8");
    const styles = await readFile(join(root, "apps/desktop/src/styles.css"), "utf8");

    expect(workspace).toContain('className="workspace-view-switcher"');
    expect(workspace).not.toContain("workspace-statusbar");
    expect(workspace).not.toContain("<VersionDialog");
    expect(styles).toContain(".workspace-scene-viewport [data-agent-hq-on-screen-controls]");
    expect(styles).toContain("left: 50%");
    expect(styles).toContain("transform: translateX(-50%)");
    expect(styles).not.toContain("--workspace-statusbar-height");
    expect(styles).toContain(".workspace-scene-tools button");
    expect(styles).toContain("width: 100%");
    expect(styles).toContain("max-width: calc(100% - 2.5rem)");
    expect(styles).not.toContain("width: 100vw");
    expect(styles).not.toContain(".workspace-status__dot");
  });

  test("puts optional authentication and identity settings behind the global rail", async () => {
    const desktop = await readFile(join(root, "apps/desktop/src/main.tsx"), "utf8");
    const rail = await readFile(
      join(root, "packages/workspace-ui/src/global-workspace-rail.tsx"),
      "utf8"
    );
    const bootstrapRoute = await readFile(
      join(root, "apps/web/src/app/api/workspaces/bootstrap/route.ts"),
      "utf8"
    );

    expect(desktop).toContain("account: {");
    expect(desktop).toContain("onSignIn:");
    expect(desktop).toContain("onSignOut:");
    expect(desktop).toContain('openSettings("account")');
    expect(rail).toContain("<AccountMenu");
    expect(rail).toContain('label="Notifications (coming soon)"');
    expect(bootstrapRoute).toContain("getUserDisplayName");
  });

  test("shares the complete version and changelog dialog across web and desktop", async () => {
    const desktopVersion = await readFile(
      join(root, "apps/desktop/src/version-dialog.tsx"),
      "utf8"
    );
    const webVersion = await readFile(
      join(root, "apps/web/src/components/version-dialog.tsx"),
      "utf8"
    );
    const sharedVersion = await readFile(
      join(root, "packages/ui/src/components/version-dialog.tsx"),
      "utf8"
    );

    expect(desktopVersion).toContain("@agent-hq/ui/components/version-dialog");
    expect(webVersion).toContain("@agent-hq/ui/components/version-dialog");
    expect(sharedVersion).toContain("What changed in this release");
    expect(sharedVersion).toContain("Installed changelog");
    expect(sharedVersion).toContain("View releases");
  });

  test("shares the global workspace rail and keeps account controls in settings", async () => {
    const desktopMain = await readFile(join(root, "apps/desktop/src/main.tsx"), "utf8");
    const desktopStyles = await readFile(join(root, "apps/desktop/src/styles.css"), "utf8");
    const webWorkspace = await readFile(
      join(root, "apps/web/src/components/workspace-shell.tsx"),
      "utf8"
    );
    const webNavigation = await readFile(
      join(root, "apps/web/src/components/workspace-navigation-entry.tsx"),
      "utf8"
    );
    const webLayout = await readFile(join(root, "apps/web/src/app/layout.tsx"), "utf8");
    const webStyles = await readFile(join(root, "apps/web/src/app/globals.css"), "utf8");
    const globalRail = await readFile(
      join(root, "packages/workspace-ui/src/global-workspace-rail.tsx"),
      "utf8"
    );
    const accountMenu = await readFile(
      join(root, "packages/workspace-ui/src/account-menu.tsx"),
      "utf8"
    );

    expect(desktopMain).toContain("<SoundProvider>");
    expect(desktopMain).toContain("<ThemeProvider>");
    expect(webNavigation).toContain("accountLabel=");
    expect(globalRail).toContain('aria-label="Global navigation"');
    expect(globalRail).toContain('label="Virtual view"');
    expect(globalRail).toContain('label="Chat view"');
    expect(globalRail).toContain('label="Plugins"');
    expect(accountMenu).toContain('aria-label="User settings"');
    expect(accountMenu).toContain("Updates");
    expect(desktopMain).toContain("onOpenUpdates: () => setUpdatesOpen(true)");
    expect(webWorkspace).not.toContain("workspace-statusbar");
    expect(desktopStyles).toContain("- 0.45rem");
    expect(desktopStyles).toContain("env(safe-area-inset-top)");
    expect(webStyles).toContain("env(safe-area-inset-top)");
    expect(webStyles).toContain("max-width: calc(100% - 2.5rem)");
    expect(webStyles).not.toContain("max-width: calc(100vw - 2.5rem)");
    expect(webLayout).toContain("themeColor:");
    expect(webWorkspace).toContain("showAccountDrawer={false}");
  });

  test("grants privileged commands only to bundled application code", async () => {
    const capability = JSON.parse(
      await readFile(join(root, "apps/desktop/src-tauri/capabilities/default.json"), "utf8")
    );

    expect(capability.remote).toBeUndefined();
    expect(capability.local).not.toBe(false);
  });

  test("pins packaged network access to the configured cloud origin", () => {
    const configured = "https://staging.agent-hq.example";
    const csp = createTauriCloudConfig(configured).app.security.csp;

    expect(csp).toContain(`connect-src 'self' blob: ipc: http://ipc.localhost ${configured} `);
    expect(csp).not.toContain("connect-src 'self' https:");
    expect(csp).not.toContain("https://agent-hq-site.vercel.app");
    expect(normalizeDesktopCloudOrigin()).toBe("https://adea.dev");
    expect(normalizeDesktopCloudOrigin("http://127.0.0.1:4305")).toBe("http://127.0.0.1:4305");
    expect(() => normalizeDesktopCloudOrigin("https://evil.example/path")).toThrow(
      "Desktop cloud origin"
    );
  });

  test("permits the bundled 3D runtime to compile trusted WebAssembly", async () => {
    const config = JSON.parse(
      await readFile(join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8")
    );
    const csp = config.app.security.csp as string;

    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-eval'");
    expect(csp).toContain("connect-src 'self' blob:");
    expect(csp).toContain("img-src 'self' asset: data: blob:");
    expect(csp).toContain("https://raw.githubusercontent.com");
    expect(csp).not.toContain("img-src 'self' https:");
  });

  test("deduplicates React across the packaged spatial runtime", async () => {
    const viteConfig = await readFile(join(root, "apps/desktop/vite.config.ts"), "utf8");

    expect(viteConfig).toContain('dedupe: ["react", "react-dom"]');
  });

  test("registers the exact desktop callback scheme and keeps server modules out of the client", async () => {
    const config = JSON.parse(
      await readFile(join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8")
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

  test("reveals and focuses the desktop window whenever a callback reaches a running app", async () => {
    const main = await readFile(join(root, "apps/desktop/src-tauri/src/main.rs"), "utf8");

    expect(main).toContain("fn reveal_main_window");
    expect(main).toContain("window.show()");
    expect(main).toContain("window.unminimize()");
    expect(main).toContain("window.set_focus()");
    expect(main.match(/receive_auth_callback/g)).toHaveLength(3);
  });

  test("uses one shared visual shell for browser and desktop authentication", async () => {
    const desktop = await readFile(join(root, "apps/desktop/src/main.tsx"), "utf8");
    const desktopStyles = await readFile(join(root, "apps/desktop/src/styles.css"), "utf8");
    const web = await readFile(join(root, "apps/web/src/app/auth/sign-in/page.tsx"), "utf8");
    const webStyles = await readFile(join(root, "apps/web/src/app/globals.css"), "utf8");
    const sharedStyles = await readFile(
      join(root, "packages/ui/src/styles/auth-shell.css"),
      "utf8"
    );

    expect(desktopStyles).toContain('@import "@agent-hq/ui/auth-shell.css"');
    expect(webStyles).toContain('@import "@agent-hq/ui/auth-shell.css"');
    expect(desktop).toContain('className="auth-shell"');
    expect(web).toContain('className="auth-shell"');
    expect(sharedStyles).toContain(".auth-panel");
    expect(sharedStyles).toContain(".auth-title");
    expect(sharedStyles).toContain("--auth-accent: var(--hq-shell-accent)");
    expect(sharedStyles).toContain("--auth-background: var(--hq-shell-background)");
    expect(desktopStyles).toContain("color: var(--hq-shell-foreground)");
    expect(desktopStyles).toContain("background: var(--hq-shell-background)");
  });

  test("provides cloud authorization, exchange, refresh, logout, and revocation handlers", async () => {
    for (const endpoint of ["authorize", "exchange", "refresh", "logout", "revoke"]) {
      const route = await readFile(
        join(root, `apps/web/src/app/api/auth/desktop/${endpoint}/route.ts`),
        "utf8"
      );
      expect(route).toContain('export const runtime = "nodejs"');
      expect(route).toContain('export const dynamic = "force-dynamic"');
    }

    const schema = await readFile(join(root, "packages/db/src/schema/desktop-auth.ts"), "utf8");
    expect(schema).toContain('"code_digest"');
    expect(schema).toContain('"credential_digest"');
    expect(schema).not.toMatch(/text\("(?:code|credential)"\)/u);
  });

  test("provides an accessible browser sign-in handoff for desktop authorization", async () => {
    const authorize = await readFile(
      join(root, "apps/web/src/app/api/auth/desktop/authorize/route.ts"),
      "utf8"
    );
    const page = await readFile(join(root, "apps/web/src/app/auth/sign-in/page.tsx"), "utf8");
    const form = await readFile(
      join(root, "apps/web/src/app/auth/sign-in/sign-in-form.tsx"),
      "utf8"
    );
    const completionPage = await readFile(
      join(root, "apps/web/src/app/auth/desktop/complete/page.tsx"),
      "utf8"
    );
    const completionClient = await readFile(
      join(root, "apps/web/src/app/auth/desktop/complete/desktop-auth-complete.tsx"),
      "utf8"
    );

    expect(authorize).toContain("createDesktopSignInUrl");
    expect(authorize).toContain("createDesktopCompletionUrl");
    expect(authorize).not.toContain("Authentication required");
    expect(page).toContain("normalizeDesktopAuthorizationReturnTo");
    expect(form).toContain('htmlFor="email"');
    expect(form).toContain('htmlFor="password"');
    expect(form).toContain('aria-live="polite"');
    expect(form).toContain("createNeonClientAdapter");
    expect(completionPage).toContain('className="auth-shell"');
    expect(completionClient).toContain("You can close this tab");
    expect(completionClient).toContain("parseDesktopCallbackFragment");
    expect(completionClient).toContain("window.history.replaceState");
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
