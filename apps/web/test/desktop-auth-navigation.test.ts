import { describe, expect, test } from "bun:test";

import {
  createDesktopCompletionUrl,
  createDesktopSignInUrl,
  normalizeDesktopAuthorizationReturnTo,
  parseDesktopCallbackFragment,
} from "../src/lib/desktop-auth-navigation";

describe("desktop browser authentication navigation", () => {
  test("sends an unauthenticated authorization request through sign-in", () => {
    const request = new URL(
      "https://agent-hq.example/api/auth/desktop/authorize?state=state&nonce=nonce&code_challenge=challenge&code_challenge_method=S256&redirect_uri=agent-hq%3A%2F%2Fauth%2Fcallback"
    );

    const signIn = createDesktopSignInUrl(request);

    expect(signIn.origin).toBe(request.origin);
    expect(signIn.pathname).toBe("@adea/auth/sign-in");
    expect(signIn.searchParams.get("returnTo")).toBe(`${request.pathname}${request.search}`);
  });

  test("accepts safe app and desktop authorization return targets", () => {
    expect(
      normalizeDesktopAuthorizationReturnTo("/api/auth/desktop/authorize?state=state&nonce=nonce")
    ).toBe("/api/auth/desktop/authorize?state=state&nonce=nonce");
    expect(normalizeDesktopAuthorizationReturnTo("/?scene=work")).toBe("/?scene=work");
    expect(normalizeDesktopAuthorizationReturnTo("https://evil.example/steal")).toBeNull();
    expect(normalizeDesktopAuthorizationReturnTo("//evil.example/steal")).toBeNull();
    expect(normalizeDesktopAuthorizationReturnTo("/api/auth/sign-out")).toBeNull();
  });

  test("keeps the one-time desktop callback in a validated completion-page fragment", () => {
    const request = new URL("https://agent-hq.example/api/auth/desktop/authorize");
    const callback =
      "agent-hq://auth/callback?code=one-time-code&nonce=nonce-value-12345&state=state-value-12345";

    const completion = createDesktopCompletionUrl(request, callback);

    expect(completion.origin).toBe(request.origin);
    expect(completion.pathname).toBe("@adea/auth/desktop/complete");
    expect(completion.search).toBe("");
    expect(parseDesktopCallbackFragment(completion.hash)).toBe(callback);
    expect(parseDesktopCallbackFragment("#callback=https%3A%2F%2Fevil.example")).toBeNull();
    expect(
      parseDesktopCallbackFragment(
        "#callback=agent-hq%3A%2F%2Fauth%2Fcallback%3Fcode%3Done-time-code%26nonce%3Dnonce-value-12345%26state%3Dstate-value-12345&callback=duplicate"
      )
    ).toBeNull();
  });
});
