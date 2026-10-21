# The integration lane's resource reuse and ownership-scoped cleanup

Status: source only. This page records the ownership rules the integration lane
follows and the evidence it leaves behind. Nothing here changes a production
resource, a shared Docker object, or any target outside the local test path.

The lane runs a local PostgreSQL instance. That instance is a resource, and a
resource that a run does not own is a resource the run must not touch. The
rules below say which instance a run may use, what it may remove when it is
done, and how the outcome is recorded.

## The two modes

The mode is explicit. `ADEA_INTEGRATION_RESOURCE_MODE` names it, and a value
the model does not understand is refused rather than guessed.

**Disposable** is the default. The run creates an instance labelled for itself,
answers on a port that belongs to it, and removes the instance and its volume
when the run ends. Two concurrent runs therefore never share a database,
because they do not share an instance, a port, or a volume.

**Reusable** is the opt-in for sequential reuse. The run uses the shared
instance in the `agent-hq` Compose project, keeps its volume between runs, and
keeps the data that the previous run left there. The instance is stopped at
the end of the run when this run started it, and left running when it was
already there.

Reuse is safe because it is exclusive. A reusable instance is claimed through
a lease, and a claim is refused while another live run holds it. A run that is
refused the shared instance takes a disposable instance of its own instead of
sharing a database with a live run.

## The ownership record

Every run writes a lease before it creates anything. The lease names the run,
the mode, the resources the run may use, the owner process, and the state of
the run. The lease lives outside the checkout, in the directory named by
`ADEA_INTEGRATION_LEASE_DIR`, or in the operating system's temporary
directory. A run that crashes leaves its lease behind, and the evidence of
what it owned outlives the process that wrote it.

The run's own identity is the proof that a lease belongs to it. A restarted
run may take its own lease back. Another run may not: a lease that names a
different resource is foreign, and a lease that cannot be understood is
uncertain. Neither is a permission, and a run that meets either one is
refused rather than guessing.

A lease records an identity, not a password. A caller-supplied target is named
by its endpoint alone.

## The shared claim

A lease says what a run owns. The claim says who may use a shared resource
right now, and it is the arbiter: one file per resource, created with an
exclusive create, so two runs that ask at the same moment cannot both hold it.
A scan of per-run records cannot do that, because two processes can both read
an empty directory and then both write into it.

A claim whose owner is gone may be taken over, but only by a run that names the
same resource identity, so a takeover can never point a shared resource at a
different project. A claim that cannot be read is uncertain, and an uncertain
claim is never taken. The claim is released with the cleanup, and a claim that
cannot be released is reported rather than hidden.

## The liveness of an owner

Whether an owner is still running is read from the process table, not assumed.
A process on another host cannot be probed from here, so its liveness is
unknown, and an unknown liveness is treated as alive: a resource somebody else
may still be holding is never taken. The same rule applies when no probe is
available at all, so a missing probe can never hand a live resource to a
second run.

## The restart

A run may name itself with `ADEA_INTEGRATION_RUN_ID`. A named run keeps its
project, its port and its database identity across a restart, so the restart
recovers the lease and the claim it recorded instead of minting a second,
conflicting identity. A restart recovers only what it recorded: it takes back
its own lease and its own claim, and it never takes a resource that names
another identity, another project, or an owner it cannot prove is gone. An
uncertain resource is left alone, and it is never recreated.

## What may be removed

The cleanup decision is about ownership, not convenience.

- An instance this run created and labelled is removed: the container, the
  volume and the network, by name, and only after the ownership label on each
  of them proves that the resource belongs to this run's Compose project.
- A shared instance is kept. The container is stopped when this run started it,
  and the volume and the network are kept for the next sequential run.
- A target the caller supplied is refused. The caller owns it, so the lane
  removes nothing.
- A resource another live run holds is refused.
- A resource whose ownership cannot be established is refused. An unreadable
  label is an unknown owner, and an unknown owner is never removed.

A removal that cannot be confirmed never counts as absent. The lane never
prunes, never removes every container, never runs a blanket teardown against
an unverified target, and never names a resource it did not record.

## Docker reuse

The image is pinned by digest in the Compose stack, and the lane reuses the
image it already has: a pinned image is immutable, so a local copy is the same
copy, and nothing about the lane's cleanup touches an image. The build layers
are reused the way the toolchain allows: the package builds run through the
orchestrator, which serves a cached build when the inputs have not changed and
rebuilds when they have. The lane never forces a pull and never prunes a
cache.

The inventory reports the image with the disposition `reuse`, so a reader can
see that the image is shared and kept.

## The reclamation safety of a resource

The Compose project label is the ownership proof. A resource that carries this
run's label was created by this run. A resource that carries another label
belongs to someone else. A resource whose label cannot be read has an unknown
owner.

An unknown owner is never a permission. In particular, a volume that is merely
unattached is not evidence of anything: an unattached volume is never safe to
delete, however old it looks. A resource that is active, caller-owned, shared,
uncertain, dirty or unpublished is protected, and the inventory says which of
those it is and why.

The inventory is a dry run. It reads the resources the lane can see and reports
each one with the disposition it would receive: reused, removable, retained or
protected. It creates nothing, claims nothing and removes nothing, and the
lane never runs a global prune, a blanket `docker compose down -v`, or a
cleanup of a resource that existed before the run.

## The disk the lane runs on

The lane creates storage, so it asks the disk first. The available space is
read from the Docker root, and a run that cannot read it is refused: an
unknown disk is not a free disk. A run that would start below the lane's
floor, or below what it needs, is refused before it claims anything and
before it creates anything. The floor and the requirement are named by
`ADEA_INTEGRATION_DISK_FLOOR_BYTES` and
`ADEA_INTEGRATION_DISK_REQUIRED_BYTES`.

## The records, their bound and the restart

Every run writes a lease before it creates anything. The lease names the run,
the mode, the resources the run may use, the owner process, and the state of
the run. The lease lives outside the checkout, in the directory named by
`ADEA_INTEGRATION_LEASE_DIR`, or in the operating system's temporary
directory. A run that crashes leaves its lease behind, and the evidence of
what it owned outlives the process that wrote it.

The run's own identity is the proof that a lease belongs to it. A restarted
run may take its own lease back. Another run may not: a lease that names a
different resource is foreign, and a lease that cannot be understood is
uncertain. Neither is a permission, and a run that meets either one is
refused rather than guessing.

Before the lane claims a lease it reconciles its own records: it reports what
they say, takes back the record of a run that is restarting with the same
identity, and prunes the settled records that are older than the retention
bound named by `ADEA_INTEGRATION_LEASE_RETENTION_MS`. A record left by a dead
run is evidence of a resource that still exists, and the lane reports it and
leaves it alone. The pruning touches the lane's own records and never a Docker
resource.

A lease records an identity, not a password. A caller-supplied target is named
by its endpoint alone.

## The evidence

The cleanup receipt separates the run's process from the run's resources. A
child that exited is not a removed container, and a resource that was kept is
not a failure. Every resource is accounted for as removed, stopped, retained
or refused, each with the reason it ended that way.

The receipt names the resources by kind, so a reader can tell a process exit
from the state of the world it left behind: the container, the volume, the
network, the database, the isolated test data inside it, and the checkout the
run used. The checkout is named as kept, because the lane never removes a
checkout.

The receipt is written into the lease, so a later run can read what the
earlier run did and did not remove. The lane prints the receipt's summary, and
a cleanup that could not complete fails the run: a teardown that did not finish
never leaves the lane green.

## Recovery

A run that ends normally, fails a suite, is interrupted by a signal, or is
killed without a chance to tidy up all reach the same cleanup, because the
lease was written before the resource was created. The signal path cleans up
before the runner re-raises the signal, and the interrupted startup never
leaves a container behind. A run that crashed leaves a lease; the run that
restarts with the same run id takes it back, and any other run leaves it
alone.

## What this does not do

- It does not reclaim stale resources. A lease left by a dead run is evidence,
  and removing the resource behind it is an operator's decision, not the
  lane's.
- It does not delete worktrees, images, containers or volumes that it did not
  create for itself.
- It does not change Docker permissions, and it does not run a prune.
- It does not retire a worktree. The checkout is only ever reported as kept.
  Retiring one needs its own path and owner verification, so it stays outside
  this work.
- It does not touch a target outside the local test path. The existing target
  guard still refuses a non-local database or HTTP target before anything
  runs, and the caller-supplied target case keeps that refusal.

## The fresh-account and the security checks

The fresh-account acceptance proves its own database, and this change does
not touch it: the fresh-Postgres lane provisions its own instance, and the
shared instance's data is not that lane's business.

The security checks are unchanged and still run. The runtime and migration
roles keep their own boundaries, the administrative URL is still a loopback
connection, the lease never holds a credential, and the ownership proof is a
label Compose writes on the resource itself.

## The code

`scripts/integration-resource-lease.mjs` holds the model: the mode, the run
identity, the lease, the claim, the cleanup plan and the receipt. It touches
no Docker and no process boundary directly, so the lifecycle can be exercised
without a daemon.

`scripts/test-integration.mjs` wires it into the lane: it claims the resource
before the instance starts, names its own project and port in every Compose
call, and cleans up only what the lease records.

`scripts/integration-resource-lease.test.ts` and
`scripts/integration-runner-lifecycle.test.ts` cover the model and the wiring
with synthetic children and a synthetic Docker. No test in either file
creates a container, a volume, a database or a worktree.
