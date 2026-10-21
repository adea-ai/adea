# M18 populated migration rollback outcome qualification

This record is the evidence for the **populated migration rollback outcome** qualification on
[#1219](https://github.com/adea-ai/adea/issues/1219) (capture), [#1222](https://github.com/adea-ai/adea/issues/1222)
(cutover) and [#1220](https://github.com/adea-ai/adea/issues/1220) (rollback fence).

It is a **mechanism qualification on a disposable, synthetic database**. It is not a production
migration, a production rollback, a production capture, a restore of user data, or a statement
that any migration is complete for any user or any environment. No production capture ran, no
production schema or migration statement executed, and no user data was read, restored or rolled
back. The qualification closes nothing: #1219, #1222 and #1220 stay open, and the rollback window
is **not** declared safe by this record.

## Provenance

| Item                                                    | Value                                                                                                                                                           |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch                                                  | `codex/f3w3-migration-rollback-qualification-20261021`                                                                                                          |
| Base                                                    | `origin/main` at `12a1830c4115eb46503a79aa0701452ac12ec695` (`fix(workspaces): recover from a reorder conflict and keep a save from being overwritten (#1542)`) |
| Qualification                                           | `packages/db/tests/integration/migration-populated-rollback-outcome-qualification.test.ts` (new, test-only)                                                     |
| This record                                             | `docs/evidence/m18-populated-migration-rollback-outcome.md` (new)                                                                                               |
| Production code, schema, migrations, snapshots, journal | unchanged                                                                                                                                                       |
| Other repository paths                                  | unchanged                                                                                                                                                       |

The delivered slices this qualification reconciles with, all already merged into `origin/main` at
the base above:

| Slice | Commit      | What this record uses from it                                                                                                                                                                                    |
| ----- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1244 | `8b6eea1e7` | `fenceLeadTurnForRollback`, `assertLeadTurnNotFenced`, `readLeadTurnRollbackState`, the attribution contract and the disposition classifier. The fence mechanics are **not** re-proved here.                     |
| #1281 | `155ed327a` | `assertDatabaseMigrationHistoryCompatible` (the migration-history preflight), run against a populated target and against a restored one.                                                                         |
| #1282 | `5e114cb58` | `migrationsFolderBefore`, the legacy audience seed writers, `reconcileLegacyAudience`, `captureGroupAudienceParticipants`, `legacyBackfillProfile`.                                                              |
| #1530 | `f8ede17f2` | The client-surface result. The surfaces a cutover must not change are **not** re-proved here; this record only checks that the rollback window does not change the audience the current product already decided. |
| #1536 | `227bfe48f` | The restored-object ordering: the restored state is read **before** anything could repair it. The restored schema objects and the refusal of an altered restored ledger are **not** repeated here.               |

Journal facts the qualification rests on: 61 journal entries, `0046_artifact_reference_grants` at
index 46, so the historical prefix is the 46 entries before the cutover and the cutover applies
the remaining 15. The quarantine profile the cutover records is
`legacy-group-audience/0050-group-legacy-backfill@dc310c7d6686efee`, the digest of the pinned
`0050_group_legacy_backfill.sql`.

## Reproduce

From the repository root, with Docker available:

```sh
node scripts/run-with-capture-provisioning.mjs -- bun --conditions=react-server test \
  packages/db/tests/integration/migration-populated-rollback-outcome-qualification.test.ts
```

The runner is plain ESM, so it is invoked with `node` where node is installed and with `bun`
where it is not. The runs recorded in Validation used `bun` 1.4.3 for both the runner and the
test, because `node` is not installed on that machine.

The runner provisions and removes a dedicated disposable PostgreSQL instance and exports its admin
URL as `MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL`. The qualification refuses to fall back to
`DATABASE_URL`; without the provisioning URL it is skipped outside CI, and in CI a missing URL
fails the suite instead of skipping it. A skipped suite is not a passing result.

The qualification creates two databases and drops both: `rollback_1220_target_*` (the live target)
and `rollback_1220_image_*` (the point-in-time image). Every name carries this run's prefix, the
server's own database and user identity are confirmed before anything is migrated, and the
cleanup attempts every step and reports the failures together.

## What the qualification does

1. **The populated historical database.** The repository's own journal prefix (46 entries, the
   SQL bytes and the ledger timestamps of that day) is applied to the disposable database. The
   workspace, its members, the workspace lead Agent, an active group with a legacy roster, one
   group message and one read state are written the way the product of that day wrote them. The
   direct Agent topic and the admissions are written directly, because the current writers name
   columns the historical schema does not have.

   Five **lead-turn admissions** are seeded in the shape 0043/0044 had, each with its own runtime
   row: a prepared attempt with no dispatch, a dispatch whose outcome was never observed
   (`dispatch_pending`), an attempt that was in flight (`running`, with its dispatch, session and
   observation), a terminal attempt that published (`completed`, with its published message), and
   a **control** that is deliberately left outside the rollback cohort.

   One legacy participant has left the workspace while their roster row survives. That surviving
   row against a missing membership is the ambiguous audience the cutover cannot prove.

2. **The point-in-time image.** The populated pre-cutover database is copied to a second
   disposable database with `CREATE DATABASE ... TEMPLATE`. This is a physical copy, the shape a
   base-backup restore produces: it carries the schema, the rows and the migration ledger, and it
   carries no role or privilege model.

3. **The cutover.** The remaining 15 journal entries are applied unchanged, with the same
   `migrate` the product's runner uses and with the production ledger location
   (`app.__drizzle_migrations`).

4. **The rollback window.** The operator declares the window and fences the cohort with
   `fenceLeadTurnForRollback` (`actor: operator`, `reason: rollback_cohort`).

5. **The point-in-time rollback.** The cut-over database is dropped and recreated from the
   pre-cutover image, and the recovered state is read before anything could repair it. The
   current chain is then re-applied forward: the repository's forward-only recovery.

## Acceptance coverage

| Test                                                                                                                   | Claim                                                                                                                                                                                                                                                                                                    | Result               |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| the disposable target is a validated loopback instance, and every database name carries this run's prefix              | The inherited target is loopback and validated before use; the two database names cannot be confused for one another.                                                                                                                                                                                    | Covered, integration |
| the populated historical database holds exactly the repository's journal prefix, and its ledger is the historical one  | 46 ledger rows; every row is the sha256 of that migration's SQL at that migration's journal timestamp.                                                                                                                                                                                                   | Covered, integration |
| the migration-history preflight accepts the populated target, and the cutover advances the ledger to the current chain | The preflight accepts the populated historical target, the cut-over target and the restored target; the cut-over ledger is the 61 current migrations, in order, unmoved.                                                                                                                                 | Covered, integration |
| the cutover carries the in-flight admissions across and invents no rollback fence for them                             | The five admissions and their five runtime rows are byte-identical before and after the cutover; the fence columns and every column the later migrations added arrive null; the canonical group tables did not exist before the cutover and exist after it.                                              | Covered, integration |
| the ambiguous legacy audience is quarantined with provenance, and the clean member keeps the channel                   | The departed participant is quarantined with reason `user_not_workspace_member`, the pinned `0050` profile, a source digest and a withdrawal digest; the original roster row is preserved; the clean member keeps its admission, the channel and its messages; the quarantined principal is denied both. | Covered, integration |
| the rollback cohort fence classifies every carried admission, and the uncertainty stays explicit                       | `no_effect_recorded`, `reconcile_uncertain_effect`, `in_flight_fenced` and `terminal_retained`; every attribution carries the operator, the reason, the retained authority and the disposition.                                                                                                          | Covered, integration |
| declaring the window twice keeps the first attribution, and the fence blocks a new effect                              | The second declaration returns `alreadyFenced: true` with the first attribution unchanged; a fenced admission is refused a new effect with `LEAD_TURN_FENCED`; the admission outside the cohort is not refused.                                                                                          | Covered, integration |
| an admission outside the cohort stays unfenced and is reported as fence_required                                       | The cohort is a cohort: the admission it did not fence is unfenced, and the product reader reports `fence_required`, never "safe".                                                                                                                                                                       | Covered, integration |
| the rollback window does not resurrect the withdrawn audience                                                          | After the window, the quarantined principal still has no admission and is still denied the channel; the clean member still has it.                                                                                                                                                                       | Covered, integration |
| the point-in-time restore rolls the populated database back to its historical schema and ledger                        | The restored ledger is the 46-row historical one; the fence columns and the canonical group tables do not exist; the five admissions and their five runtime rows are unchanged; the seven seeded messages are exactly the seeded set.                                                                    | Covered, integration |
| the forward-only recovery re-applies the cutover without loss and invents no fence                                     | The recovered ledger is the 61 current migrations; the population is unchanged; the fence columns are back and null.                                                                                                                                                                                     | Covered, integration |
| the quarantine provenance is re-established after the rollback, for the same principals                                | The source digest is the same digest; the same principals are quarantined for the same reasons; the derived authority names the same principals and grants.                                                                                                                                              | Covered, integration |
| the cohort must be fenced again after the rollback, and the dispositions are the same                                  | The fence did not survive the restore, so the cohort has to be fenced again; the evidence did survive it, so the classification is the same one.                                                                                                                                                         | Covered, integration |

## The rollback outcome

**The migration carries the population across and invents nothing.** The five admissions and their
five runtime rows are identical before and after the cutover. The rollback fence's five columns
(0054) and the model-selection and handoff columns (0047, 0052) arrive null. The uncertain attempt
is still uncertain after the cutover: the migration resolved nothing, and nothing in it is
reported as safe to resume.

**The window's fence classifies the population it covers, and leaves the rest explicitly
unresolved.** The cohort fence records `no_effect_recorded` for the prepared attempt,
`reconcile_uncertain_effect` for the dispatch whose outcome was never observed, `in_flight_fenced`
for the attempt that was in flight and `terminal_retained` for the terminal attempt that
published. The admission outside the cohort stays unfenced and the product reader reports
`fence_required` for it: the window is a cohort, and an admission it did not fence is never
silently treated as safe.

**The window does not resurrect withdrawn authority.** The legacy audience the cutover could not
prove stays quarantined with its recorded reason, its pinned source profile, its source digest and
its withdrawal digest. The clean member keeps its admission, its channel and its messages.

**A point-in-time restore rolls the fence back with the schema.** This is the operationally
important finding. The restored pre-cutover image has no fence columns at all, so the fence the
window wrote is gone; the forward-only recovery re-adds the columns as null, so the migrated
database cannot tell that the window was ever declared. **After any point-in-time restore the
cohort has to be fenced again.** The evidence the fence classified did survive the restore — the
uncertain attempt is still uncertain, the in-flight attempt is still in flight, the terminal
attempt is still terminal — so the second declaration produces exactly the same four dispositions.
The populated data survives the restore and the recovery unchanged: the same five admissions, the
same five runtime rows and exactly the same seven messages.

**The recovery is forward-only, and the preflight says so.** The restored ledger is a prefix of
the candidate chain, so the migration-history preflight accepts it: nothing would be skipped and
nothing moved. The repository's own rule already is that production rollback is forward-only
(`packages/db/README.md`); this qualification measures that rule against a populated target
instead of a synthetic fixture, and shows the re-applied chain re-establishes the same quarantine
provenance for the same principals.

**The ledger is the identity.** Every historical ledger row is the sha256 of that migration's SQL
at that migration's journal timestamp, so the populated historical database is provably the
database of that age and not a look-alike.

## What this qualification does not establish

- **No migration completion is claimed.** This is a mechanism qualification on synthetic rows in
  one disposable instance. It does not establish that any user's migration is complete, that the
  production ledger is at the current head, that the production candidate set is correct, or that
  the historical population in production matches anything seeded here.
- **Owner gate.** The production operator still has to reconcile the exact production ledger and
  the candidate rows against the current chain, validate the deployed role split (the runtime role
  and the migration role), and arrange write quiescence or a reviewed retry window for the
  cutover. The fence's `operator` kind is trusted in-process **by reference**: there is no
  operator identity system, so who may declare the window and how the cohort is chosen are
  operational decisions this record does not make. Production lock durations and production-sized
  data volumes are not measured here; the synthetic timings in
  [m18-1222-legacy-audience-quarantine-qualification.md](m18-1222-legacy-audience-quarantine-qualification.md)
  are not production estimates either.
- **Native gate.** The runtime's native session inventory is not a database family. No user's
  native session file is read, no runtime host is contacted, and the native-session family stays
  `unknown` in every snapshot comparison (as in #1530 and in the cutover rehearsal). The runtime
  owns the session and its monotonic generation; the restore authority for a hosted database is a
  separate decision. Nothing here is a no-send proof and nothing here is a generation-authority
  proof.
- **Product gate.** The client surfaces a cutover must not change are owned by #1530 and are not
  re-proved here; this record only checks that the rollback window does not change the audience
  the current product already decided. The control-plane fence-v2 consumer contract, claim-time
  enforcement, fence persistence and disposition handling live in the control plane and are not
  re-verified here; see
  [m18-01-3-rollback-fencing.md](m18-01-3-rollback-fencing.md). **The rollback window is still not
  declared safe.**
- **Restore shape.** The point-in-time image here is a physical copy of a synthetic disposable
  database. It is not a logical dump, it carries no role or privilege model, and it does not
  model a partially-written or torn restore, a restore onto a different PostgreSQL major version,
  or a restore that carries a partially applied migration.
- **Scope of the fence slice.** The fence's own mechanics — attribution immutability, the refusal
  of a partial attribution, the outsider's isolation, the lock order, the publication block and the
  archived-history rules — are owned by #1244 and were not re-proved here.

## Validation

All commands were run from the repository root at
`12a1830c4115eb46503a79aa0701452ac12ec695` with the **repository-pinned Bun 1.4.3**
(`packageManager: bun@1.4.3`, `.mise.toml` `bun = "1.4.3"`, revision `c6da4a4d3`) and PostgreSQL
18.6 (the digest-pinned capture image `public.ecr.aws/docker/library/postgres:18-alpine`) in a
Docker daemon on the host. The machine's default `bun` on `PATH` is 1.4.2; every command below
ran with the pinned 1.4.3 first on `PATH`, and **no result here was taken from Bun 1.4.2**. The
dependencies were installed with the pinned toolchain
(`bun install --frozen-lockfile`, `Checked 867 installs across 1082 packages (no changes)`), and
`node` is not installed on this machine, so the repository's `.mjs` runner is invoked with `bun`
rather than `node`.

| Command                                                                                                                                                                                                                                            | Result                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `bun scripts/run-with-capture-provisioning.mjs -- bun --conditions=react-server test packages/db/tests/integration/migration-populated-rollback-outcome-qualification.test.ts`                                                                     | **15 pass, 0 fail, 490 expect() calls**, 24.65 s, exit 0   |
| `bun scripts/run-with-capture-provisioning.mjs -- bun --conditions=react-server test packages/db/tests/integration/migration-cutover-client-surface-equality.test.ts packages/db/tests/integration/migration-cutover-rehearsal.test.ts`            | **29 pass, 0 fail, 339 expect() calls**, 82.16 s, exit 0   |
| `bun x tsc --noEmit -p packages/db/tsconfig.json` (after `bun run --cwd packages/types build`, `bun run --cwd packages/remote-content build`, `bun run --cwd packages/auth build`)                                                                 | clean, exit 0                                              |
| `bun x tsc --ignoreConfig --noEmit --skipLibCheck --module preserve --moduleResolution bundler --target esnext --strict --jsx preserve --types bun-types packages/db/tests/integration/migration-populated-rollback-outcome-qualification.test.ts` | clean, exit 0                                              |
| `bun x oxlint --deny-warnings`                                                                                                                                                                                                                     | exit 0                                                     |
| `bun x oxfmt --check .`                                                                                                                                                                                                                            | `All matched files use the correct format.`, exit 0        |
| `bun test scripts/docs-boundary.test.ts`                                                                                                                                                                                                           | 4 pass, 0 fail, 15 expect() calls, exit 0                  |
| `bun test packages/db/tests/unit`                                                                                                                                                                                                                  | 706 pass, **1 fail**, 8043 expect() calls, 13.75 s, exit 1 |

The second row is the compatibility check on the shared tooling this qualification builds on: the
#1241 cutover rehearsal and the #1530 client-surface proof still pass against the same fixtures,
in the same lane, with the new file present.

The #1244 owner slice was also run, to confirm the fence semantics this qualification reconciles
with are green on this base. It needs the lane's _migrated_ application database rather than the
capture URL, so it was run against a throwaway instance that the repository's own
`scripts/capture-provisioning.mjs` provisioned, migrated with the database package's guarded
runner (`bun src/verify-migrations.ts`, `Migration verification passed (61 applied migration(s))`),
with `DATABASE_URL` pointed at that instance. The wrapper that did this was a throwaway script
outside the repository and is not part of this change. Result: **18 pass, 0 fail, 81 expect()
calls**, 68.09 s, exit 0, with `--timeout 60000`.

At the **default** 5 s timeout the same slice is flaky on this machine: **15 pass, 3 fail**,
exit 1, and all three failures are `this test timed out after 5000ms` rather than an assertion
failure — among them `A31 fencing a terminal admission records attribution and blocks unpublished
results without rewriting history` at 5009.96 ms. That file is not touched by this change, and
every one of its cases passes with the raised bound. The bounded run is the result recorded above;
the default-timeout observation is recorded here rather than waived.

The one unit failure is pre-existing and unrelated, and it is **not** waived:
`packages/db/tests/unit/lead-production-factory-process.test.ts`, `failed preflight command stderr
never reaches parent output`, expects an exit code of 1 and reads `undefined`. It fails the same
way on the pristine base with this change's two files moved aside (**12 pass, 1 fail**, exit 1, on
that file alone), and it is in code this change does not touch.

**Not run.** The full `bun run test:integration` lane (every package integration file, the route
flow and the Docker Compose instance), the root `bun run test:unit` and `bun run test:coverage`
lanes, the web build and bundle checks, the E2E, packaged and desktop suites, and the
control-plane joined proof. The lanes above are the focused checks that apply to a test-only
addition in the database package; the wider lanes were not exercised, and their results are not
claimed.

**No external change.** Nothing was published, merged, deployed or pushed; no credential, secret or
production resource was created, read or changed; no worker was started beyond the throwaway
Docker instance the repository's own runner provisions and removes; and no production capture,
migration, schema execution or user-data rollback was performed.
