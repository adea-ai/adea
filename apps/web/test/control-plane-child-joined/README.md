# Joined backend evidence for Adea #1211

This opt-in source proof sends a real PostgreSQL-backed Adea lead intent through
the authenticated production product reader to the Control Plane production
factory. Lead and child model references come from its model-selection service
and are pinned on the immutable Adea intent. The Control Plane runs in a separate
process using its configured Bun runtime and compiler context.

Run after building Adea's DB dependencies and the pinned Control Plane factory
dependencies. Supply an existing isolated local PostgreSQL target at
`127.0.0.1:55432`, `ADEA_CONTROL_PLANE_SOURCE`, and the absolute
`PI_FACTORY_BUN` executable:

```sh
bun run test:integration:control-plane-child
```

Missing configuration, a different CP head, or a dirty CP source tree fails the
run. The source revision in `source.json` includes CP #1041. The default test
lanes do not load this directory. This source proof does not replace the verified
public-package candidate manifest required for full #1211 acceptance.

The actual services exercised are Adea's canonical intent and audience reader,
its signed service verifier, CP model selection, production lead preparation,
current child authority, production child delegation and the transactional SQLite
child allocator. Account evidence, scope policy, the tool registry/policy and the
provider transport are explicit synthetic host ports. The fixture does not
discover credentials, import Home configuration or use a live provider.

The retained run at CP `c5387139f8aa20af498fa96f32fb24ca8248c5d4` passes signed
host-workspace denial, exact requested-role preparation without inference, and
location/current-payer refusal without fallback. The positive child allocation
check fails: the actual allocator's current-authority recheck does not return
within eight seconds. Its diagnostic records `allocator-authority-recheck`, zero
physical sends and zero secret resolutions. The host is terminated if graceful
cleanup stalls; its owned disposable directory is removed only after the process
is reaped. Adea's fixture workspace is archived and its temporary session expires.

## Remaining dependencies

- Resolve the CP current-authority recheck under the allocator transaction.
  The model-selection repository and canonical allocator currently share the
  fixture's SQLite provider. Re-entry through model readiness is a candidate
  cause, not a confirmed diagnosis. Do not bypass the recheck to obtain a green
  result.
- Verify the parent/child budget policy, separately recorded child funding and
  actual child-runtime admission after allocation completes. This run does not
  reach those boundaries.
- Produce and verify the updated public-package candidate manifest, then run
  the installed SDK consumer journey. This direct source proof makes no package,
  live-account, device, deployment, restart or publication qualification claim.
- CP935's session/task/generation binding and preparation-target work remains
  separately owned. This draft does not modify those paths.

The allocation failure is asserted as a failure, never skipped or counted as
passing. #1211 remains open; its UI and independent-session acceptance belong to
their existing owners.
