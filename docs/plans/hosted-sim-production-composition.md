# Hosted Sim production composition: decisions still required

This is a proposed composition, not an installed production authority. The local
acceptance services use disposable entitlement and storage. Production
`sim-api.ts` intentionally supplies no issuer, so a configured hostname still
returns `unavailable/not_configured`.

## Entitlement authority

The missing decision is the existing authoritative entitlement source and its
policy for signed-in users, temporary users, workspace membership, and the three
surfaces. Official origin, desktop distribution, possession of the app, and a
client platform hint do not establish entitlement.

After that decision, the Adea request composition can resolve its existing
`resolveWorkspacePrincipal(request, { createTemporary: false })`, apply existing
`authorizeWorkspace(principal, 'workspace.read', workspaceId)`, and bind the
approved `SimEntitlementChecker` to that authenticated request. A membership
check alone must not return `entitled`. The entitlement adapter must distinguish
unauthenticated, not entitled, unavailable, and entitled results; failures remain
closed. Existing desktop/cookie/temporary principal semantics must be preserved.

## Durable storage

The missing authority is the approved existing storage target and permission to
add the code/session records and host access needed there. No such access or
schema change has been made. A suitable composition must implement:

- `SimLaunchCodeStore.issue`: short-lived opaque code binding to bridge nonce,
  exact Sim origin, surface, and expiry.
- `SimLaunchCodeStore.redeem`: atomic single-use consumption, including competing
  hosts and invalid/replayed/expired presentations. An in-process map or a
  read-then-delete sequence is insufficient.
- `SimSessionStore.save` and the host's session lookup: persistent Sim-only
  surface/expiry records shared by the authorized host replicas, with bounded
  cleanup and the agreed revocation policy.
- Private export reads: a named private asset location accessible only through
  the session gate, including entry/surface binding and no public storage alias.

Existing Postgres infrastructure could support transactional code redemption and
session lookup if its owner approves the target, schema, access, and lifecycle.
That is a proposal; no database provider, migration, binding, or credential has
been silently selected or created.

## Specific runtime policy decision

The actual private engine uses Three.js embedded GLB textures. Its image-bitmap
loader fetches same-document `blob:` URLs; the current new host's
`connect-src 'self'` blocks those reads. The specific proposed source change is
`connect-src 'self' blob:` on the separate Sim document. All other directives,
exact parent origins, cookie host separation, session/private asset gates, and
script restrictions would stay as implemented. The no-security-changes
instruction leaves this change pending authorization. No external hostname needs
to be added. Private engine portal prefetch now stays on the current origin.

## Live rollout authorization

Before a live run, name the approved private host and asset/storage targets,
approve the entitlement composition, and authorize the exact deployment,
hostname/DNS, binding, schema/access, or credential actions that are necessary.
New credentials/access, paid changes, security changes, releases, production
deployment, and infrastructure mutation remain excluded until explicitly
authorized. Existing published installers remain unchanged.

Root owns source review, readiness, and merge for Adea #1448 and private AgentSim
#111. Both remain drafts with auto-merge off. Local browser and unsigned package
evidence must not be described as live rollout completion.
