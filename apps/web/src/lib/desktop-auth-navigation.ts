const DESKTOP_AUTHORIZATION_PATH = "/api/auth/desktop/authorize";

export function createDesktopSignInUrl(authorizationUrl: URL) {
  const signInUrl = new URL("/auth/sign-in", authorizationUrl.origin);
  signInUrl.searchParams.set("returnTo", `${authorizationUrl.pathname}${authorizationUrl.search}`);
  return signInUrl;
}

export function normalizeDesktopAuthorizationReturnTo(value: string | null | undefined) {
  if (!value?.startsWith(`${DESKTOP_AUTHORIZATION_PATH}?`)) return null;
  try {
    const target = new URL(value, "https://agent-hq.invalid");
    if (
      target.origin !== "https://agent-hq.invalid" ||
      target.pathname !== DESKTOP_AUTHORIZATION_PATH
    ) {
      return null;
    }
    return `${target.pathname}${target.search}`;
  } catch {
    return null;
  }
}
