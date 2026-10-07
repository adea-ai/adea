# Control Plane request credentials

Adea authenticates every Control Plane request with a short-lived Ed25519
service JWT that it signs itself, scoped to exactly the Adea workspace (and
project) the request is for. This is the Adea half of
[ADR 0013](decisions/0013-control-plane-workspace-mapping.md). This page covers
how the mapping and signer work, and the owner runbook for provisioning,
verifying, rotating and finally removing the static-token fallback.

The production signer was provisioned on 2026-10-06 with key id
`adea-web-signer-2026-10`, and the static-token fallback has since been
removed from the code (step 6). Run the commands below only as the owner,
against the environment you mean to change.

## How it works

- **Mapping.** Each workspace has `workspaces.control_plane_workspace_id`
  (`wsp_…`) and each project `projects.control_plane_project_id` (`prj_…`):
  prefixed ULIDs in the Control Plane grammar
  `^(wsp|prj|tsk|agt)_[0-9A-HJKMNP-TV-Z]{26}$`, unique, never reused, never
  derived from the Adea UUID. `createWorkspaceWithOwner` and `createProject`
  mint them (`packages/db/src/control-plane-identifiers.ts`). Migration
  `0033_control-plane-scopes` adds `app.control_plane_identifier(prefix)` as
  the column default. Adding a column with a volatile default makes
  PostgreSQL evaluate it once per existing row, so the migration backfills
  every existing row with its own value: a 48-bit millisecond timestamp plus
  80 random bits from `gen_random_uuid()`. The same default covers any insert
  path that does not mint, including the previous Worker during the
  expand-only rollout.
- **Signer.** `apps/web/src/server/control-plane-credential.ts` signs one JWT
  per request:
  - header `{alg: "EdDSA", kid: <key id>, typ: "JWT"}`;
  - claims `audience: "control-plane"`;
  - a unique `credentialId` (`adea-web:<uuid>`);
  - `credentialKind: "service"`;
  - `issuedAt` and an `expiresAt` two minutes later (five minutes at most);
  - `issuer`;
  - `keyId` (equal to `kid`);
  - `principalId: "svc_agent-hq"`;
  - `workspaceIds: [<mapped wsp_>]`;
  - `projectIds: [<mapped prj_>]`, or `[]` for workspace routes;
  - only the scopes the route needs.

  | Call                                    | Scopes                     | `projectIds` |
  | --------------------------------------- | -------------------------- | ------------ |
  | Marketplace catalog, installation get   | `marketplace:read`         | `[]`         |
  | Marketplace install, install-plan       | `marketplace:install`      | `[]`         |
  | Marketplace installation uninstall      | `marketplace:uninstall`    | `[]`         |
  | Project-state initialization            | `project-state:initialize` | `[<prj_>]`   |
  | Workspace skills and profiles: list     | `catalog:read`             | `[]`         |
  | Workspace skill publish                 | `catalog:publish`          | `[]`         |
  | Skill/profile deprecate, revoke         | `catalog:manage`           | `[]`         |
  | Cloud connections: list                 | `credential:read`          | `[]`         |
  | Cloud connection create, rotate, revoke | `credential:write`         | `[]`         |

  The Control Plane trusted keys (`CONTROL_PLANE_SERVICE_AUTH_TRUSTED_KEYS`)
  carry only `keyId` and `publicKey`; they do not restrict scopes. Each route
  checks the scopes the signed claims carry, so adding a scope here needs no
  Control Plane configuration change.

- **Project state.** Creating an Adea project initializes revision 0 of its
  Control Plane project state (`POST /v1/project-states/initialize`) so cloud
  executions for the project can validate
  (`apps/web/src/server/control-plane-project-state.ts`). It runs after the
  project row commits and after the response, through the Worker's
  `waitUntil`, in its own request scope and with a five-second timeout, so it
  never fails or delays project creation. The envelope names the mapped
  `wsp_` and `prj_`, the payload is `{}` with the SHA-256 of `{}` as its
  hash, and the idempotency key is `project-state-init:<prj_>`, fixed per
  project, so every retry replays the original. A `200` and
  `409 PROJECT_STATE_ALREADY_INITIALIZED` both count as initialized; any other
  outcome logs one `control_plane.project_state.initialize_failed` line
  (project id, status, Control Plane error code; never the credential) and is
  swallowed. `ensureControlPlaneProjectState` is the lazy path: a future
  project-scoped Control Plane call awaits it first, so a project whose
  initialization failed, or that predates this change, is initialized on
  first use. No project-scoped call exists yet.

- **Workspace Skills and cloud connections.** The catalog and credential
  vault routes (Workspace settings › Skills and › Connections › Cloud) speak
  contract major 3
  (`/v1/catalog/{skills,profiles}/*`, `/v1/credentials/*`) and, like every
  Control Plane route, run only under a signed credential for the caller's
  own mapped workspace. Any member
  may read; publish, deprecate, revoke and every credential write need
  `workspace.update` (owners and admins). The cloud connection secret is
  write-only: Adea accepts it on create and rotate, forwards it once in the
  request payload, leaves it out of `payloadHash` (the Control Plane hashes
  the same non-secret fields), never logs it, never stores it, and rebuilds
  every response from an allow-list of metadata fields. Adea's database holds
  nothing for cloud connections; the Control Plane is the source of truth.
  Proxy failures log one `control_plane.admin.failed` line with the
  operation, status, a sanitized code and the request id — never a body.

  The administration hop uses the published `@adea-ai/sdk` **1.11.0** and
  `@adea-ai/contracts` **1.14.0**, pinned exactly in the web manifest and Bun
  lockfile. The SDK owns request and response validation and contract-version
  compatibility. The repository pins Node 24.21.0 to meet both packages' runtime
  requirement. Adea also verifies response request/trace identity, sends
  both correlation headers, refuses redirects, and bounds each hop to five
  seconds. An incompatible, malformed, or miscorrelated response is unavailable;
  upstream error text and validation details never reach clients or logs.
  `CONTROL_PLANE_ORIGIN` is a root origin without credentials, path, query,
  or fragment. HTTPS is required, with loopback HTTP allowed only outside
  production. The SDK and its runtime schemas are blocked from browser bundles.
  These pins cover administration today; execution submission, Local IPC,
  and remote relay integration remain M11 work.

- **Marketplace.** The proxy sets both the envelope `workspaceId` and the
  nested `workspaceIdentity.workspaceId` to the active workspace's mapped
  `wsp_`. Each workspace therefore has its own installations and idempotency
  namespace. The Control Plane keys installs by (workspace, key), and the
  install-plan key hashes the scoped payload.
- **No fallback.** There is no static-token path. A deployment without
  `CONTROL_PLANE_SIGNING_KEY` has no Control Plane credential: marketplace,
  Skills and cloud connection requests fail closed with
  `503 CONTROL_PLANE_UNAVAILABLE` without calling the Control Plane, and
  project-state initialization is skipped with a
  `control_plane.project_state.initialize_skipped` debug line (the lazy path
  initializes the project once a key is bound). If the key is set but the key
  id, issuer, key format or workspace mapping is invalid, requests fail
  closed the same way. `CONTROL_PLANE_SERVICE_TOKEN` and
  `CONTROL_PLANE_SCOPE_WORKSPACE_ID` are no longer read.

| Name                           | Kind                   | Value                                                              |
| ------------------------------ | ---------------------- | ------------------------------------------------------------------ |
| `CONTROL_PLANE_SIGNING_KEY`    | Secret (Secrets Store) | Ed25519 private key, PKCS#8 PEM or private JWK                     |
| `CONTROL_PLANE_SIGNING_KEY_ID` | Text binding           | Key id, `^[A-Za-z0-9._:-]{1,128}$`, e.g. `adea-web-signer-2026-10` |
| `CONTROL_PLANE_SIGNING_ISSUER` | Text binding           | Exactly the Control Plane's `CONTROL_PLANE_SERVICE_AUTH_ISSUER`    |

All three are in the client-bundle denylist (`apps/web/start/client-policy.mjs`).

## Provisioning runbook

### 1. Generate the key pair

Generate the key pair on a trusted machine, in a private directory:

```bash
umask 077
openssl genpkey -algorithm ed25519 -out control-plane-signing.pem
# The Control Plane trusted key is the raw 32-byte public key, base64url, unpadded (43 chars):
openssl pkey -in control-plane-signing.pem -pubout -outform DER | tail -c 32 \
  | base64 | tr '+/' '-_' | tr -d '=\n'; echo
```

Alternatively, with Bun:

```bash
bun -e '
const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
await Bun.write("control-plane-signing.pem",
  `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`);
console.log((await crypto.subtle.exportKey("jwk", pair.publicKey)).x);'
```

Choose a new key id, for example `adea-web-signer-2026-10`. Never reuse a
key id for a different key.

### 2. Trust the public key in the Control Plane (Railway)

On the Control Plane `control-api` service, append the public key to
`CONTROL_PLANE_SERVICE_AUTH_TRUSTED_KEYS`. That variable is a JSON array of
1–32 entries with unique key ids. Keep the existing entry for the static
token until step 6 retires it:

```json
[
  { "keyId": "adea-web-2026-10", "publicKey": "<existing 43-char base64url key>" },
  { "keyId": "adea-web-signer-2026-10", "publicKey": "<new 43-char base64url key>" }
]
```

`CONTROL_PLANE_SERVICE_AUTH_ISSUER` stays as it is: an HTTPS URL that the
Control Plane compares exactly with the `issuer` claim. Adea's
`CONTROL_PLANE_SIGNING_ISSUER` must be the same string. Redeploy
`control-api` so it reloads its configuration.

### 3. Store the private key and bind it to the Worker

`cf deploy` replaces the Worker's whole binding set (see
[CLOUDFLARE.md](../apps/web/CLOUDFLARE.md)). A `wrangler secret put` value
would therefore vanish on the next deploy. Store the key in the
`control-plane-neon` Secrets Store instead:

```bash
bunx wrangler secrets-store secret create b3a1b4e8427a4d23ac7925cc18a7a2ac \
  --name ADEA_CONTROL_PLANE_SIGNING_KEY --scopes workers --remote
```

The prompt reads one line. Paste the PEM with its newlines escaped as `\n`
(the signer accepts that form). This command prints it:
`awk '{printf "%s\\n", $0}' control-plane-signing.pem`. A one-line private
JWK also works. Delete the local key file once the secret is stored and
verified.

Then add the binding to both deploy configurations in one reviewed pull
request, and deploy:

- `apps/web/cloudflare.config.ts`:
  - `CONTROL_PLANE_SIGNING_KEY: bindings.secretsStoreSecret({ storeId: controlPlaneStore, secretName: 'ADEA_CONTROL_PLANE_SIGNING_KEY' })`;
  - `CONTROL_PLANE_SIGNING_KEY_ID: bindings.text('<key id>')`;
  - `CONTROL_PLANE_SIGNING_ISSUER: bindings.text('<issuer>')`.
- `apps/web/wrangler.jsonc`: the same three names. Put the key in
  `secrets_store_secrets`, and the key id and issuer in `vars`.

Once the key binding is present, every marketplace request is signed. For
local preview, put the same three names in `apps/web/.dev.vars` (see
`.dev.vars.example`) with a development key that a local Control Plane
trusts.

### 4. Verify

Mint a credential for a known mapped workspace and call the Control Plane's
authentication probe. Find the workspace's mapping with a read-only query:
`select control_plane_workspace_id from app.workspaces where id = '<uuid>'`.

```bash
export CONTROL_PLANE_SIGNING_KEY="$(cat control-plane-signing.pem)"
export CONTROL_PLANE_SIGNING_KEY_ID=adea-web-signer-2026-10
export CONTROL_PLANE_SIGNING_ISSUER='<issuer>'
export WSP='wsp_…'   # the mapped workspace
TOKEN=$(bun -e '
import { controlPlaneCredential } from "./apps/web/src/server/control-plane-credential.ts";
const c = await controlPlaneCredential({ scopes: ["system:authenticate"],
  resolveScope: async () => ({ workspaceId: process.env.WSP }) });
console.log(c.token);')
curl -sS -X POST "$CONTROL_PLANE_ORIGIN/v1/authentication/verify" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"caller\":{\"servicePrincipalId\":\"svc_agent-hq\"},\"contractVersion\":{\"major\":2,\"minor\":0},\"correlation\":{\"traceId\":\"trc_01JABCDEF0123456789ABCDEFG\"},\"operation\":\"authentication.verify\",\"requestId\":\"req_01JABCDEF0123456789ABCDEFG\",\"requestedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"workspaceId\":\"$WSP\"}"
```

A good response is `200` with `data.principal.workspaceIds == ["wsp_…"]`.
Common rejections:

- `SERVICE_CREDENTIAL_MALFORMED`: the key is not trusted, or `kid` does not
  match.
- `SERVICE_CREDENTIAL_INVALID_ISSUER`: the issuer strings differ.
- `SERVICE_CREDENTIAL_SCOPE_MISMATCH`: the envelope workspace is not the one
  you minted for.

Then open Plugins in two different workspaces on the deployed host. Each
should list its own installations. Create a project and check that the
Worker logs show no `control_plane.project_state.initialize_failed` line for
it.

### 5. Rotate

1. Generate a new key pair with a new key id (step 1).
2. Add the new public key to `CONTROL_PLANE_SERVICE_AUTH_TRUSTED_KEYS` next
   to the current one, and redeploy `control-api`.
3. Update the Secrets Store record and `CONTROL_PLANE_SIGNING_KEY_ID` in both
   config files, then deploy the Worker.
4. Once every isolate is on the new key, remove the old public key from the
   trusted keys. Credentials live at most five minutes, so ten minutes after
   the deploy is enough.

For an emergency, add the offending `credentialId` values (`adea-web:<uuid>`)
to `CONTROL_PLANE_SERVICE_AUTH_REVOKED_CREDENTIAL_IDS`. To revoke a leaked
key, remove its public key from the trusted keys.

### 6. Remove the static-token fallback

Code side done: the signer was provisioned in production on 2026-10-06
(`adea-web-signer-2026-10`), and this repository no longer has the fallback.

1. Done: `CONTROL_PLANE_SERVICE_TOKEN` and `CONTROL_PLANE_SCOPE_WORKSPACE_ID`
   are gone from both deploy configs, the env examples and the client
   denylist.
2. Done: `fallbackCredential` and the `unscoped` mode are gone from the
   signer, together with the `CONTROL_PLANE_UNSCOPED` refusal. Without a
   signing key every request fails closed with `CONTROL_PLANE_UNAVAILABLE`.

Remaining owner actions, after the change above is deployed:

3. Revoke the static credential (`adea-web-worker-v2`). On the Control Plane
   `control-api` service, add its `credentialId` to
   `CONTROL_PLANE_SERVICE_AUTH_REVOKED_CREDENTIAL_IDS`, drop its trusted key
   (`adea-web-2026-10`) from `CONTROL_PLANE_SERVICE_AUTH_TRUSTED_KEYS`, and
   redeploy `control-api`.
4. Delete the `AGENT_HQ_CONTROL_PLANE_PRODUCTION_SERVICE_TOKEN` record from
   the `control-plane-neon` Secrets Store. No binding references it any more.
