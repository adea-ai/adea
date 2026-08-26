import { createNeonServerAdapter, parseDesktopAuthorizationRequest } from "@agent-hq/auth/server";

import {
  desktopAuthorizationBroker,
  desktopPrincipalMapping,
} from "../../../../../server/desktop-auth";
import {
  createDesktopCompletionUrl,
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
    const principal = await resolveOrProvisionDesktopPrincipal(
      authentication,
      desktopPrincipalMapping(),
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
