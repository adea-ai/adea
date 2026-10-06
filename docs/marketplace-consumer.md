# Marketplace consumer contract

Adea uses the plugin registry maintained in
[`adea-ai/plugins`](https://github.com/adea-ai/plugins). Core catalog discovery is
server-side through Control Plane:

- Registry latest pointer:
  `https://raw.githubusercontent.com/adea-ai/plugins/catalog-assets/catalog-latest.v1.json`
- Immutable snapshot URL:
  `https://raw.githubusercontent.com/adea-ai/plugins/catalog-assets/catalogs/<catalogId-suffix>/catalog.v1.json`
- Immutable directory: `catalogs/<catalogId-suffix>` for `catalog:<64 lowercase hex>`.

The snapshot path is derived from the catalog's own digest, so a pinned URL is
immutable by construction: a build that produced different bytes has a different
`catalogId` and cannot write over an existing path. The pointer is the only
mutable path, and it is byte-identical to the `catalog.v1.json` of the snapshot
it names.

Adea retrieves the core catalog through the same-origin
`/api/marketplace/catalog` route, which calls the authenticated Control Plane
catalog proxy. Control Plane fetches and verifies the registry, then returns
catalog artifacts and sanitized installation state. The browser may fetch the
optional public `catalog-index.v1.json` URL declared by the verified categories
artifact. It accepts the browsing index only when its canonical digest and
catalog ID match the verified catalog; otherwise it renders from the full
catalog. Display icons may load directly from upstream icon URLs, compiled
publication marks, or third-party favicon and brand services. These display
requests carry no plugin installation or execution authority.
An index freshness probe may also read only the catalog ID to decide whether to
retain an already verified cache. Probe contents are not used as new catalog
entries without verification.

The Plugins action remains unavailable until
workspace bootstrap resolves, so provider loading never races workspace identity.
Configure the proxy with:

- `CONTROL_PLANE_ORIGIN`: HTTPS Control Plane origin in production;
- `CONTROL_PLANE_SIGNING_KEY`, `CONTROL_PLANE_SIGNING_KEY_ID`,
  `CONTROL_PLANE_SIGNING_ISSUER`: the server-only Ed25519 signer that mints a
  per-request credential for the active workspace
  ([ADR 0013](decisions/0013-control-plane-workspace-mapping.md); see the
  [Control Plane credentials runbook](control-plane-credentials.md));
- until the signer is provisioned, the fallback pair
  `CONTROL_PLANE_SERVICE_TOKEN` (server-only static service credential) and
  `CONTROL_PLANE_SCOPE_WORKSPACE_ID` (its single service scope).

The example configuration points to the online production catalog API. Railway staging
is an on-demand reference environment and normally has no running services. For local
Docker testing, override `CONTROL_PLANE_ORIGIN` with your mapped Control Plane origin
and use a credential and workspace scope issued by that local instance. Keep these
values server-only; production HTTPS remains required.

Each Adea workspace maps to its own Control Plane workspace (`wsp_…`, minted
by Adea and stored on the workspace). With the signer configured, the proxy
names the active workspace's mapped scope in the top-level request
`workspaceId`, in the nested `workspaceIdentity.workspaceId`, and as the only
entry of the credential's `workspaceIds`. Each workspace therefore has its
own installations and idempotency namespace: the Control Plane keys installs
by (workspace, key), and the install-plan key hashes the scoped payload. A
workspace without a mapped scope fails closed with `CONTROL_PLANE_UNAVAILABLE`.
The caller's Adea workspace UUID never crosses the hop.

In the unscoped fallback, every Adea workspace shares the single configured
service scope, which is used for both the top-level and the nested ID, as
before. The Control Plane catalog and install routes require the two IDs to
match. The deployment reports this mode with one
`control_plane.credential.unscoped` log line per Worker isolate.

Before accepting a catalog, the shared provider validates `schemaVersion: 1`,
the `catalogId` body digest, required integrity-listed artifact digests, and
that `catalog-latest.v1.json` is byte-identical to `catalog.v1.json`. Canonical
JSON sorts object keys, preserves array order, and uses the registry's
`sha256:...` digest format. The provider keeps no copied catalog source tree.
The optional browsing index must also have a declared digest when present.

The following values are opaque and must be preserved exactly:

| Field                                        | Use                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `catalogId`                                  | Complete immutable catalog snapshot identity.                                                           |
| `pluginId`                                   | Source-qualified stable plugin identity.                                                                |
| `releaseId`                                  | Exact immutable plugin release identity.                                                                |
| `canonicalContentDigest`                     | Exact normalized content digest to persist and submit.                                                  |
| `releaseMetadata.agentPlugins.packageDigest` | Derived canonical package recipe digest, when present; descriptive until Control Plane confirms a plan. |
| `harnessCompatibility`                       | Per-harness descriptive compatibility; not an execution grant.                                          |
| `requiredConnectors`                         | Connector authorities required by the release.                                                          |
| `requiredCredentials`                        | Credential requirement names; never secret values.                                                      |
| `securityClassification`                     | Sensitivity, resolution, and permission-impact metadata.                                                |
| `provenance`                                 | Source repository, manifest, path, and resolved commit metadata.                                        |

For releases with `releaseMetadata.agentPlugins`, Adea first calls the
same-origin `/api/marketplace/install-plan` route. The returned plan must
match the requested `pluginId`, `releaseId`, and stable installation instance;
`allowedToActivate` must remain `false` and `approvalRequired` must remain
`true`. The plan is advisory only: it does not authorize materialization,
credentials, network access, dependency installation, or activation. Adea
fails closed on a missing, malformed, or mismatched plan. Legacy releases
without Agent Plugins metadata retain the existing install compatibility path.

The Add/Enable request to Control Plane includes `pluginId`, exact `releaseId`,
exact `canonicalContentDigest`, requested harness, a stable installation
instance scoped to the workspace/user/plugin, and workspace/user identity. It
is idempotent. Adea may display canonical Agent Plugins status (`portable`,
`partial`, or `unavailable`) but never treats it as authorization. It may
also display states returned by Control Plane such as
`pending-authorization`, `unavailable`, `rejected-by-policy`, `installed`, and
`superseded`, but it must not mark an item installed from local storage. The
current install endpoint verifies the request and persists state and exact
pins. Its `installed` response does not establish filesystem materialization
or harness activation.

Adea does not download or execute upstream plugin source. Control Plane
verifies immutable releases server-side, rechecks content digests, applies
revocation, supersession, workspace policy, and connector/credential checks,
and persists exact installation pins. Actual materialization and activation
remain separate runtime work with their own authorization checks. A
metadata-only or quarantined plugin is not executable content.
