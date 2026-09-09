# Marketplace consumer contract

Adea uses the plugin registry maintained in
[`adea-ai/plugins`](https://github.com/adea-ai/plugins). Discovery is
server-side through Control Plane:

- Registry latest artifact:
  `https://github.com/adea-ai/plugins/releases/latest/download/catalog-latest.v1.json`
- Registry latest integrity manifest:
  `https://github.com/adea-ai/plugins/releases/latest/download/integrity.json`
- Immutable release URL:
  `https://github.com/adea-ai/plugins/releases/download/catalog/<catalogId-suffix>/catalog.v1.json`
- Immutable tag: `catalog/<catalogId-suffix>` for `catalog:<64 lowercase hex>`.

Adea does not request those GitHub URLs from a browser or desktop client.
The same-origin `/api/marketplace/catalog` route calls the authenticated
Control Plane catalog proxy. Control Plane fetches the registry and returns
sanitized artifact metadata only. The Plugins action remains unavailable until
workspace bootstrap resolves, so provider loading never races workspace identity.
Configure the proxy with:

- `CONTROL_PLANE_ORIGIN` — HTTPS Control Plane origin in production;
- `CONTROL_PLANE_SERVICE_TOKEN` — server-only scoped service credential;
- `CONTROL_PLANE_SCOPE_WORKSPACE_ID` — server-side service scope.

Before accepting a catalog, the shared provider validates `schemaVersion: 1`,
the `catalogId` body digest, all five integrity-listed artifact digests, and
that `catalog-latest.v1.json` is byte-identical to `catalog.v1.json`. Canonical
JSON sorts object keys, preserves array order, and uses the registry's
`sha256:...` digest format. The provider keeps no copied catalog source tree.

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
`superseded`, but it must not mark an item installed from local storage.

Adea never downloads or executes upstream plugin content. Control Plane
must fetch immutable releases server-side, re-verify content digests, enforce
revocation/supersession and workspace policy, resolve connectors and
credentials, and persist exact release pins in installation and execution
records. A metadata-only or quarantined plugin is not executable content.
