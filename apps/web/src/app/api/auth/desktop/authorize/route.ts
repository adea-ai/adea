import { resolveAuthenticatedPrincipal } from "@agent-hq/auth";
import { createNeonServerAdapter, parseDesktopAuthorizationRequest } from "@agent-hq/auth/server";

import {
  desktopAuthorizationBroker,
  desktopPrincipalMapping,
} from "../../../../../server/desktop-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const authorization = parseDesktopAuthorizationRequest(request);
    const authentication = await createNeonServerAdapter().getSession();
    if (!authentication) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }
    const principal = await resolveAuthenticatedPrincipal(
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
    return new Response(null, {
      status: 303,
      headers: {
        "cache-control": "no-store",
        location: callback,
        "referrer-policy": "no-referrer",
      },
    });
  } catch {
    return Response.json({ error: "Invalid desktop authorization request" }, { status: 400 });
  }
}
