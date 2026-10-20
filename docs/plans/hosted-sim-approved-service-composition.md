# The approved hosted Agent Sim service: source interfaces and prerequisites

Status: source only. Nothing here is wired into a production route, no hosting destination has
been chosen, no credential exists and no live grant has been issued. This page records the source
interfaces an approved service composes, and the decisions root still owns.

The production composition proposal remains in
[hosted-sim-production-composition.md](hosted-sim-production-composition.md). This page records
what the source now provides and what it deliberately still does not.

## The two services

The hosted Agent Sim is two services with one contract between them.

### The Adea-side launch service

`apps/web/src/server/sim-launch-service.ts` composes the launch. It is written against ports, so
it names no entitlement source, no storage engine and no origin.

```ts
const launch = createSimLaunchService({
  frameOrigin: process.env.ADEA_SIM_ORIGIN ?? null,
  createStore: createSimIssuerStores(applicationDatabase()),
  ports: {
    resolvePrincipal,
    authorizeWorkspace,
    policy,
  },
})
```

The order of the decision is fixed and is the security property:

1. `resolvePrincipal` resolves the request's authenticated principal. No principal is
   `unauthenticated`.
2. `authorizeWorkspace(principal, 'workspace.read', workspaceId)` decides the workspace read. A
   principal without it is `not_entitled`, and the policy is never asked.
3. `policy({ workspaceId, surface, platform })` is the only source that may answer `entitled`.
   Membership alone never entitles, an unknown answer is closed, and a throwing source is
   `unavailable`.

The code store is bound to the workspace the request named _and_ the entitlement verified, so a
code can never be issued against a workspace the account may not use. `createSimIssuerStores`
refuses a workspace identifier outside the database shape rather than writing it.

An absent `frameOrigin` is `not_configured`, not a default. The production route
(`apps/web/src/server/sim-api.ts`) installs no policy and therefore issues nothing.

### The separately hosted service

`apps/web/src/server/sim-host-service.ts` composes the hosted origin. It owns the session gate and
nothing else.

```ts
const host = createSimHostService({
  configuration: {
    origin,
    parentOrigins,
    assetPrefix,
    entryFiles,
  },
  store: createSimRedemptionStore(applicationDatabase()),
  sessions: createSimSessionLookup(applicationDatabase()),
  policy,
  readAsset,
  frameScript,
})
```

The hosted service redeems one single-use code per launch, mints the sim-only cookie, looks the
session up in durable storage, asks the entitlement policy about the workspace and surface the
**stored row** names, and only then reads a private object.

- The workspace and surface always come from the stored session row. No request body, query string
  or header can select them, so a read cannot be aimed at another workspace or surface.
- The store must provide the atomic redemption. The session is written in the same step as the code
  spend, so a failed session write leaves the code redeemable instead of consuming a launch. A
  separate session write is refused outright.
- `createSimRedemptionStore` refuses to issue codes. Only the Adea backend issues them, and a code
  issued by the hosted service would have no verified workspace to bind to.

### The private asset location

`apps/web/src/server/sim-private-assets.ts` reads the engine export from one named private
location.

```ts
const reader = createSimPrivateAssetReader({
  location: 'agent-sim-export',
  read: async ({ location, key }) => storage.get(location, key),
})
```

The location name is a plain identifier, not a URL, a path or an alias, so nothing here can name a
public bucket or a public prefix. The reader hands the location and the key to the storage adapter
and returns the object; it never returns a location, a URL or a redirect, so this service offers no
second route to a private object. A malformed location name serves no object at all rather than
falling back to a default, and a request path cannot select a key outside the location.

What this source does **not** decide, and what the deployment must therefore supply:

- the access control list that makes the location private, so that no other principal and no
  unsigned request can read the objects;
- the absence of a public alias for the same objects — a public URL, a public CDN route, a public
  bucket or prefix, or any other route the storage provider may expose for them;
- the expiry of any signed URL or temporary credential the storage adapter may use.

Identifier and key validation alone prove none of that. The request-side gate is proven by the
source and its tests; the storage-side gate is a deployment prerequisite, listed below.

## The durable storage

The launch code and the session it mints live in the app database, in the `sim_launch_codes` and
`sim_sessions` tables (`packages/db/drizzle/0059_sim_launch_sessions.sql`). Only digests are stored.
The code is spent by its first presentation inside a row lock, and the session is written in the
same transaction as that spend.

`packages/db/src/sim-launch-ports.ts` provides the three adapters:

| Adapter                    | Used by                | Contract                                                                                            |
| -------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------- |
| `createSimIssuerStores`    | the Adea launch        | one store per verified workspace; a refused workspace identifier is never written                   |
| `createSimRedemptionStore` | the hosted service     | redeems only; issuing is refused                                                                    |
| `createSimSessionLookup`   | the private asset gate | resolves the stored row's workspace, surface and expiry; unknown, expired and revoked never resolve |

The database integration suite (`packages/db/tests/integration/sim-launch-sessions.test.ts`)
covers the transactional behaviour against a real PostgreSQL: replay, concurrent consumption,
expiry, a foreign bridge or origin, a failed session save and the revocation of a live session.

## What the approved service still needs from root

These are decisions and actions, not source. None of them has been made here.

1. **The entitlement policy.** The authoritative source that answers `entitled` for a workspace and
   a surface, and its policy for signed-in users, temporary users, workspace membership and the
   three surfaces. No such source exists in this repository today.
2. **The hosting destination.** The exact origin of the separately hosted service, its DNS, its
   cookie host separation from the app origin, and the deployment of that service. The host
   configuration refuses a parent on the same cookie host, so the destination cannot be a sibling
   path of the app origin.
3. **The private asset location.** The named private location that holds the engine export and the
   storage adapter that reads it. The engine export itself stays in the private repository; no
   engine source or binary is copied into this repository.
4. **The private storage configuration.** The access control list that makes the location private,
   the confirmation that the storage provider exposes no public alias for the same objects, and the
   expiry of any signed URL or temporary credential the adapter uses. This source validates the
   location name and the request key; it cannot validate any of that.
5. **The storage prerequisites.** The `sim_launch_codes` and `sim_sessions` migration applied to the
   target database, the read and write access for the launch and the hosted service, and the
   cleanup of expired codes and sessions.
6. **The deployment.** Building and deploying the separately hosted service, and any credential,
   binding or access change it needs. None of that is authorized here.

## What this page does not claim

No live hosting, deployment, hostname, DNS, binding, credential, access change or entitlement grant
exists. The local acceptance services use disposable entitlement and storage. A configured hostname
alone grants nothing: without an installed policy the launch answers
`unavailable/not_configured`.
