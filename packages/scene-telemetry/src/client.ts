type NavigationType = "navigate" | "push" | "replace" | "traverse";

type NavigationStart = {
  id: string;
  url: string;
  startTime: number;
  type: NavigationType;
  claimed?: boolean;
};

declare global {
  interface Window {
    __AGENT_HQ_NAVIGATION_START__?: NavigationStart;
    __AGENT_HQ_SCENE_TELEMETRY_ENDPOINT__?: string;
    __AGENT_HQ_RELEASE__?: string;
  }
}

export function recordNavigation(url: string, type: NavigationType, startTime: number): void {
  window.__AGENT_HQ_NAVIGATION_START__ = {
    id: `nav-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    url,
    startTime,
    type,
  };
}

try {
  const navigation = performance.getEntriesByType("navigation")[0] as
    PerformanceNavigationTiming | undefined;
  recordNavigation(window.location.href, "navigate", navigation?.startTime ?? 0);
  const endpoint =
    process.env.NEXT_PUBLIC_SCENE_TELEMETRY_ENDPOINT ||
    (process.env.NODE_ENV === "production" ? "/api/telemetry/scene-performance" : undefined);
  if (endpoint) window.__AGENT_HQ_SCENE_TELEMETRY_ENDPOINT__ = endpoint;
  const release = process.env.NEXT_PUBLIC_DEPLOY_GIT_COMMIT_SHA;
  if (release) window.__AGENT_HQ_RELEASE__ = release;
} catch {
  // Telemetry must never interfere with page initialization.
}

export function onRouterTransitionStart(
  url: string,
  navigationType: "push" | "replace" | "traverse"
): void {
  try {
    recordNavigation(new URL(url, window.location.href).href, navigationType, performance.now());
  } catch {
    // Invalid route metadata should not affect navigation.
  }
}
