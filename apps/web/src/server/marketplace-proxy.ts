import { createHash, randomBytes } from "node:crypto";

const contractVersion = { major: 2, minor: 0 } as const;

export async function proxyMarketplaceCatalog(
  input: Readonly<{ workspaceId: string; userId: string }>
): Promise<Response> {
  const requestId = identifier("req");
  const traceId = identifier("trc");
  return proxyControlPlane(
    "/v1/marketplace/catalog",
    {
      caller: { servicePrincipalId: "svc_agent-hq" },
      contractVersion,
      correlation: { traceId },
      operation: "marketplace.catalog.read",
      parameters: { workspaceIdentity: input },
      requestId,
      requestedAt: new Date().toISOString(),
      workspaceId: requiredControlPlaneWorkspaceId(),
    },
    requestId
  );
}

export async function proxyMarketplaceInstall(
  input: Readonly<{
    canonicalContentDigest: string;
    idempotencyKey: string;
    pluginId: string;
    releaseId: string;
    requestedHarness: string;
    workspaceIdentity: Readonly<{ userId: string; workspaceId: string }>;
  }>
): Promise<Response> {
  const requestId = identifier("req");
  const traceId = identifier("trc");
  const commandId = identifier("cmd");
  const payload = { ...input };
  return proxyControlPlane(
    "/v1/marketplace/install",
    {
      caller: { servicePrincipalId: "svc_agent-hq" },
      commandId,
      contractVersion,
      correlation: { traceId },
      idempotencyKey: input.idempotencyKey,
      issuedAt: new Date().toISOString(),
      operation: "marketplace.install.request",
      payload,
      payloadHash: sha256(canonicalJson(payload)),
      requestId,
      workspaceId: requiredControlPlaneWorkspaceId(),
    },
    requestId
  );
}

function requiredControlPlaneWorkspaceId(): string {
  const value = process.env.CONTROL_PLANE_SCOPE_WORKSPACE_ID?.trim();
  if (!value || !/^wsp_[0-9A-HJKMNP-TV-Z]{26}$/u.test(value)) {
    throw new MarketplaceProxyError("CONTROL_PLANE_UNAVAILABLE", "Control Plane is not configured");
  }
  return value;
}

async function proxyControlPlane(
  path: string,
  body: Record<string, unknown>,
  requestId: string
): Promise<Response> {
  const origin = process.env.CONTROL_PLANE_ORIGIN?.trim();
  const token = process.env.CONTROL_PLANE_SERVICE_TOKEN?.trim();
  if (!origin || !token)
    throw new MarketplaceProxyError("CONTROL_PLANE_UNAVAILABLE", "Control Plane is not configured");
  let url: URL;
  try {
    url = new URL(path, origin.endsWith("/") ? origin : `${origin}/`);
  } catch {
    throw new MarketplaceProxyError("CONTROL_PLANE_UNAVAILABLE", "Control Plane is not configured");
  }
  if (url.protocol !== "https:" && process.env.NODE_ENV === "production")
    throw new MarketplaceProxyError("CONTROL_PLANE_UNAVAILABLE", "Control Plane is not configured");
  try {
    const response = await fetch(url, {
      body: JSON.stringify(body),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Request-ID": requestId,
      },
      method: "POST",
    });
    if (!response.ok) {
      const status = response.status >= 500 ? 503 : response.status;
      throw new MarketplaceProxyError(
        status === 503 ? "CONTROL_PLANE_UNAVAILABLE" : "MARKETPLACE_REQUEST_REJECTED",
        status === 503
          ? "Control Plane is unavailable"
          : "Control Plane rejected the marketplace request",
        status
      );
    }
    const envelope = (await response.json()) as { data?: unknown };
    if (!envelope || !("data" in envelope))
      throw new MarketplaceProxyError(
        "CONTROL_PLANE_UNAVAILABLE",
        "Control Plane returned an invalid response"
      );
    return Response.json(envelope.data);
  } catch (error) {
    if (error instanceof MarketplaceProxyError) throw error;
    throw new MarketplaceProxyError(
      "CONTROL_PLANE_UNAVAILABLE",
      "Control Plane is unavailable",
      503
    );
  }
}

export class MarketplaceProxyError extends Error {
  constructor(
    readonly code: "CONTROL_PLANE_UNAVAILABLE" | "MARKETPLACE_REQUEST_REJECTED",
    message: string,
    readonly status = 503
  ) {
    super(message);
    this.name = "MarketplaceProxyError";
  }
}

function identifier(prefix: "cmd" | "req" | "trc"): string {
  return `${prefix}_${randomBytes(13).toString("hex").toUpperCase()}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}
