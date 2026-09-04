# Marketplace consumer contract

Agent HQ uses the plugin registry maintained in
[`0xPlayerOne/plugins`](https://github.com/0xPlayerOne/plugins). Discovery is
server-side through Control Plane:

- Registry latest artifact:
  `https://github.com/0xPlayerOne/plugins/releases/latest/download/catalog-latest.v1.json`
- Registry latest integrity manifest:
  `https://github.com/0xPlayerOne/plugins/releases/latest/download/integrity.json`
- Immutable release URL:
  `https://github.com/0xPlayerOne/plugins/releases/download/catalog/<catalogId-suffix>/catalog.v1.json`
- Immutable tag: `catalog/<catalogId-suffix>` for `catalog:<64 lowercase hex>`.

Agent HQ does not request those GitHub URLs from a browser or desktop client.
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

| Field                    | Use                                                              |
| ------------------------ | ---------------------------------------------------------------- |
| `catalogId`              | Complete immutable catalog snapshot identity.                    |
| `pluginId`               | Source-qualified stable plugin identity.                         |
| `releaseId`              | Exact immutable plugin release identity.                         |
| `canonicalContentDigest` | Exact normalized content digest to persist and submit.           |
| `harnessCompatibility`   | Per-harness descriptive compatibility; not an execution grant.   |
| `requiredConnectors`     | Connector authorities required by the release.                   |
| `requiredCredentials`    | Credential requirement names; never secret values.               |
| `securityClassification` | Sensitivity, resolution, and permission-impact metadata.         |
| `provenance`             | Source repository, manifest, path, and resolved commit metadata. |

The Add/Enable request to Control Plane includes `pluginId`, exact `releaseId`,
exact `canonicalContentDigest`, requested harness, and workspace/user identity.
It is idempotent. Agent HQ may display states returned by Control Plane such as
`pending-authorization`, `unavailable`, `rejected-by-policy`, `installed`, and
`superseded`, but it must not mark an item installed from local storage.

Agent HQ never downloads or executes upstream plugin content. Control Plane
must fetch immutable releases server-side, re-verify content digests, enforce
revocation/supersession and workspace policy, resolve connectors and
credentials, and persist exact release pins in installation and execution
records. A metadata-only or quarantined plugin is not executable content.
