import { createNeonServerAdapter, parseDesktopAuthorizationRequest } from "@adea-ai/auth/server";

import { isAllowedEmail } from "../../../../../server/allowed-emails";
import {
  desktopAuthorizationBroker,
  desktopPrincipalMapping,
} from "../../../../../server/desktop-auth";
import {
  createDesktopCompletionUrl,
  createDesktopErrorCompletionUrl,
  createDesktopSignInUrl,
} from "../../../../../lib/desktop-auth-navigation";
import { resolveOrProvisionDesktopPrincipal } from "../../../../../server/desktop-principal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const authorization = parseDesktopAuthorizationRequest(request);
    const authentication = await createNeonServerAdapter().getSession();
    if (!authentication) {
      const signIn = createDesktopSignInUrl(new URL(request.url));
      return new Response(null, {
        status: 303,
        headers: {
          "cache-control": "no-store",
          location: `${signIn.pathname}${signIn.search}`,
        },
      });
    }
    // Account allowlist: when configured, only listed emails may start a
    // desktop session. Rejected accounts land on the early-access notice in
    // the browser, and the completion hash returns an error to the app so it
    // leaves the waiting state.
    if (!isAllowedEmail(authentication.profile.email)) {
      const completion = createDesktopErrorCompletionUrl(new URL(request.url), "early_access");
      return new Response(null, {
        status: 303,
        headers: {
          "cache-control": "no-store",
          location: `${completion.pathname}${completion.hash}`,
          "referrer-policy": "no-referrer",
        },
      });
    }
    const principal = await resolveOrProvisionDesktopPrincipal(
      authentication,
      desktopPrincipalMapping()
    );
    if (!principal) return Response.json({ error: "Forbidden" }, { status: 403 });

    const callback = await desktopAuthorizationBroker().issue({
      ...authorization,
      providerExpiresAt: Date.parse(authentication.session.expiresAt),
      providerSessionId: authentication.session.id,
      userId: principal.userId,
    });
    const completion = createDesktopCompletionUrl(new URL(request.url), callback);
    return new Response(null, {
      status: 303,
      headers: {
        "cache-control": "no-store",
        location: `${completion.pathname}${completion.hash}`,
        "referrer-policy": "no-referrer",
      },
    });
  } catch {
    return Response.json({ error: "Invalid desktop authorization request" }, { status: 400 });
  }
}
