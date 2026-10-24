# M18 exact-candidate certification (#1225, #1223, #1224)

This is the non-UI exact-candidate certification record for Adea issues
[#1225](https://github.com/adea-ai/adea/issues/1225),
[#1223](https://github.com/adea-ai/adea/issues/1223) and
[#1224](https://github.com/adea-ai/adea/issues/1224). It maps every requirement
id and every A01-A40 acceptance id to an exact repository commit, an exact
package version, a named test and an evidence class, gives every row an
individual disposition, and reports what is still open.

The runner is `scripts/evidence-candidate-certification.mjs`; its tests are
`scripts/evidence-candidate-certification.test.ts`.

**Nothing here is a release certification.** No id is certified. The reasons
are listed per id, per candidate and per gate, and none of them is estimated.

At the frozen source candidate the record reads:

```
certification: incomplete (0 of 64 certified; 28 source-verified; 9 external gates open)
```

| Disposition   | Count | Meaning                                                                        |
| ------------- | ----- | ------------------------------------------------------------------------------ |
| `passed`      | 28    | the row's cited tests were re-run at the candidate and every title passed      |
| `skipped`     | 11    | a qualifying test exists and is named, but this runner does not run it         |
| `unavailable` | 23    | the row's evidence needs an artifact, an environment or a head that is missing |
| `untestable`  | 2     | no test file in the repository mentions the row's subject at all               |
| `failed`      | 0     | —                                                                              |

Every one of the 64 rows has a disposition, and the 36 rows the manifest maps
no evidence for are inventoried individually below with the readiness
criterion that names them, the manifest's own gap text, the subject that was
searched for, and the lead that was found and the lane it belongs to.

## The frozen source candidate

There are two exact revisions in this record, and they are not the same thing.

| Role                           | Value                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------ |
| Repository                     | `adea-ai/adea`                                                                 |
| **Frozen source candidate**    | `85be87e3f9e9da0d5cde917c4faf37b7b364b693`                                     |
| Verified from                  | `refs/heads/main` of `adea-ai/adea`, read with the existing remote credentials |
| Package version at that commit | `0.99.0` (root `package.json`) and `0.99.0` (`@adea-ai/types`)                 |
| **Artifact candidate**         | the branch head that carries this record, published as draft PR #1550          |
| Branch                         | `codex/f3w5-adea-20261021`                                                     |

The **source candidate** is the product source that is certified. It is
`origin/main` at the time of the run, and it is the tree the clean checkout
exports, the packages are built from, and the readiness probes are measured
at. It contains no file of this work.

The **artifact candidate** is the branch head that carries the runner, its
tests and this record. It is `main` plus exactly three owned files, so the
product content of the artifact candidate is byte-identical to the source
candidate. The runner is invoked with `--base` so that the two never blur.

### Reconciling the advance of main

`main` moved six commits between the previous base and this one, and all six
are other owners' merges:

| Commit      | Pull request | What it merged                                                                     |
| ----------- | ------------ | ---------------------------------------------------------------------------------- |
| `9f3280b40` | #1546        | remote-content: request-bound return envelopes across runtimes                     |
| `beb62c2b0` | #1544        | types: runtime connection and profile execution read models (#37/#41/#186)         |
| `f673af22f` | #1545        | db: qualify the populated migration rollback outcome (#1219/#1222/#1220)           |
| `f4bee99c7` | #1547        | workspaces: complete the protected Home lifecycle (#1214/#1175)                    |
| `73e444f59` | #1552        | remote-content: label the cross-runtime return vector as public synthetic material |
| `85be87e3f` | #1543        | ci: give the integration lane a resource ownership and reuse policy                |

**None of the 27 cited test files changed.** No cited title was invalidated by
the advance. The cited tests were still re-run at the new candidate, because a
test that has not been re-run says nothing about a new commit. The last of the
six, #1543, changes the integration lane's resource lease and its runner; it
touches no cited test, no owned path and no product source file, and the
qualification was run again at that commit to show that the result is
unchanged: the same 28 passed, 11 skipped, 23 unavailable, 2 untestable, 0
failed and 0 certified.

What the advance did change is the **pending-row inventory**: three owners
merged the very tests that many of the pending rows said were missing.
`apps/web/test/integration/protected-home-lifecycle.test.ts`,
`packages/db/tests/integration/personal-workspaces.test.ts`,
`packages/db/tests/integration/blank-workspace-isolation.test.ts`,
`packages/db/tests/integration/workspace-leads.test.ts`,
`packages/db/tests/integration/migration-populated-rollback-outcome-qualification.test.ts`,
`packages/types/tests/execution-location.test.ts` and the two
`packages/remote-content/tests/unit/remote-result*.test.ts` files are now
available qualifications for rows that previously had none. The runner finds
them, runs them, and reports them against the row they cover. Three rows moved
out of `untestable` because of them.

The evidence manifest's own pin is unchanged at
`e8b75daa5cc996a4c0d84489a3885535c3045a2f`, which is 276 commits behind the
candidate. The manifest is **not** re-pinned: it belongs to another owner,
and re-pinning it would declare the changed behaviors covered without
requalifying them. What this runner does instead is re-run every cited test at
the candidate and report the result.

## What this is, and what it is not

The merged evidence manifest (`docs/plans/m18-evidence-manifest.json`, merged in
[#1236](https://github.com/adea-ai/adea/pull/1236)) answers whether a requirement
id is _internally consistent_: whether the cited test title exists at the pinned
revision and whether a recorded run of that file passed. Its validator,
`scripts/evidence-manifest.mjs`, reports the certification state of the
manifest as a whole.

This document answers the other question. For each id it records:

- the exact commit the evidence is bound to,
- the owning workspace package and the version it declares **at that commit**,
- the test file and the declared test titles,
- the evidence class, and the disposition of that class at the candidate.

The evidence classes are distinct and are not a single scale of confidence.
They name **where** the evidence was produced:

| Class                    | What it proves                                                                    | Reachable here                |
| ------------------------ | --------------------------------------------------------------------------------- | ----------------------------- |
| `source`                 | A test ran in a clean checkout of one exact commit.                               | yes                           |
| `disposable-integration` | A test ran against a disposable local database in a clean checkout of one commit. | yes, with a loopback database |
| `packaged-native`        | A packaged or native artifact built from one exact commit was exercised.          | no                            |
| `deployed`               | A deployed environment built from one exact commit was exercised.                 | no                            |
| `owner-daily-driver`     | The owner's own daily use accepted the behaviour.                                 | no, it is a human decision    |

Only the first two are reachable from this repository without a release. The
last three are reported as open, with their owner, and are never inferred from
a source-level result.

## Ownership and exclusions

Files this work owns and changes:

- `scripts/evidence-candidate-certification.mjs`
- `scripts/evidence-candidate-certification.test.ts`
- `docs/plans/m18-candidate-certification.md`

Files this work reads but does not change:

- `docs/plans/m18-evidence-manifest.json` and `docs/plans/m18-evidence-manifest.md`
  (merged in #1236),
- `scripts/evidence-manifest.mjs` and `scripts/evidence-manifest.test.ts`
  (merged in #1236; the runner imports its id universe, its JUnit parser and
  its bounded git reader),
- `docs/plans/m18-readiness-inventory.json`, `docs/plans/m18-readiness-measurements.json`
  and `docs/plans/m18-readiness-inventory.md` (merged in #1252/#1260),
- `apps/web/test/control-plane-joined/control-plane-source.json` (the existing
  cross-repository pin).

No feature source, no other owner's path, no test of another owner, and no
credential, deployment or release was touched. The runner writes only into a
temporary directory that it removes again.

## Reconciliation of the merged inputs

### What the three issues cover

| Issue | Scope as this repository records it                                                                                                                                                       | State at the certification candidate                                                                                                                                             |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1225 | the requirement ids and the A01-A40 acceptance ids, and their evidence                                                                                                                    | the merged manifest and validator (#1236) are in the candidate; every id is `pending` and no candidate evidence is attached                                                      |
| #1223 | cross-product session journeys (#1249, `159d4bf3792ae9a54f05e78918c2742b6b98a22a`) and desktop retained session transfer and fallback (#1285, `864745ae87c252e8b291c9cff7408bf0deb4ee59`) | both merged into the candidate; the **cross-product** gate stays open because the joined journey needs one exact pair of candidate heads from both repositories                  |
| #1224 | the release-readiness inventory, its criteria and its measurements (#1252/#1260)                                                                                                          | merged into the candidate; the candidate heads it measured are historical drafts, and its criteria for the 24-hour soak, the cost states and the owner journey are `unavailable` |

The evidence manifest's pin `e8b75daa5cc996a4c0d84489a3885535c3045a2f` is the
commit of the last evidence-manifest refresh, `web: close empty-data and
deleted-workspace coverage for the global directory callers (#1174) (#1251)`.

### The merged inputs

| Input                                    | Pull request                                                       | Commit                                     | In the certification candidate |
| ---------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------ | ------------------------------ |
| Evidence manifest validator and manifest | [#1236](https://github.com/adea-ai/adea/pull/1236)                 | `40f54c826aa31de022b8596ec9c379bb61c132a8` | yes                            |
| Readiness inventory and measurements     | [#1252](https://github.com/adea-ai/adea/pull/1252) (merge `#1260`) | `c6ace36270d525d7be80a5eead42bc87101dbffc` | yes                            |
| Cross-product session journeys           | #1249                                                              | `159d4bf3792ae9a54f05e78918c2742b6b98a22a` | yes                            |
| Desktop retained session transfer        | #1285                                                              | `864745ae87c252e8b291c9cff7408bf0deb4ee59` | yes                            |
| Artifact-reference grants                | #1246                                                              | `34a3eaad69b6f2d671fd802bfe21bb629e7609ff` | yes                            |
| Home lead provisioning                   | #1238                                                              | `449568904e99718cf52e63fadad6dac58db7e277` | yes                            |

**#1253 does not exist as a pull request in `adea-ai/adea`.** The remote
publishes no `refs/pull/1253/head` and no `refs/pull/1253/merge`, no commit in
this repository names it, and no file in the repository references it. It is
therefore not a merged pull request, and nothing was reconciled from it. If
#1253 is an issue rather than a pull request, its text is not in this
repository, and this record does not claim to cover it.

The generic validator was run read-only against the candidate. It reports:

```
revisions: adea@e8b75daa5cc996a4c0d84489a3885535c3045a2f
sources: adea local
{"pending":64,"invalid":0,"repo-verified":0,"candidate-compatible":0}
certification: incomplete (0 of 64 candidate-compatible)
candidate-compatible proof: missing for 64 of 64 ids
```

That is the correct reading of the manifest as it stands: every id is
`pending` because every entry is `coverage: partial` and no entry carries
candidate evidence. `compatibility.contractVersions` is empty, so no candidate
contract is compatible with the manifest as written.

## The candidate and dependency commit matrix

Every SHA in this table was read from an authorized ref or an existing local
checkout and verified to exist. Nothing here is inferred.

### This repository, read with the existing remote credentials

| Ref                   | SHA                                        | Role                                                |
| --------------------- | ------------------------------------------ | --------------------------------------------------- |
| `refs/heads/main`     | `85be87e3f9e9da0d5cde917c4faf37b7b364b693` | **the frozen source candidate**                     |
| `refs/pull/1515/head` | `312c49db2e77371cf38a5397c386439494e53019` | an open draft, not merged, not a candidate          |
| `refs/pull/1518/head` | `fcb72ad807d95fa82bb9b76801a24b16c0cccb0e` | an open draft, not merged, not a candidate          |
| `refs/pull/1522/head` | `a18e35ff2e213133480811435b47107a68c6e2b3` | an open draft, not merged, not a candidate          |
| `refs/pull/1525/head` | `f37411f4d0aed067c66a37b40d1d30af9bd85a37` | an open draft, not merged, not a candidate          |
| `refs/pull/1542/head` | `fd177baf38ad7e72eb14abd9cb6bfab766f90861` | the pre-merge head of the commit that is now `main` |

### This branch and its pull request

| Ref                    | SHA                                        | Role                                                    |
| ---------------------- | ------------------------------------------ | ------------------------------------------------------- |
| `refs/pull/1550/head`  | `a68e96a75124da98ead6b1543785874ad1c1d2b9` | the draft pull request's head when it was opened        |
| `refs/pull/1550/merge` | `1043cd116ee28e99c715de15cb71cc685a0d2697` | GitHub's computed merge of the pull request with `main` |

Draft pull request #1550 is **open, draft, not merged, auto-merge off**, with
one commit and three changed files. Its eight check runs are one success
(the draft guard) and seven correctly skipped change-scoped gates: the diff
touches `scripts/` and `docs/plans/` only, so the host, visual and desktop
gates do not apply. No check on the pull request fails.

### The control-plane repository, read with the existing remote credentials

| Ref                   | SHA                                        | Role                                                                                      |
| --------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `refs/heads/main`     | `b1dee8b9ce083512642777d92d3a441a882e8b5c` | the control-plane main                                                                    |
| `refs/pull/1210/head` | `95021f73a1127d117317ed78e5d7466f3ad61783` | the published control-plane candidate head for #1210                                      |
| `refs/pull/943/head`  | **absent**                                 | **CP #943 has no pull request**, so there is no control-plane candidate head to pair with |

`95021f73a1127d117317ed78e5d7466f3ad61783` is present in the local
control-plane checkout, and so is the pinned control-plane revision
`1aa42ff20c7fe1b0d9cc484983a7a631f4589746` that this repository already pins in
`apps/web/test/control-plane-joined/control-plane-source.json`, together with
its two component heads `3118a7c9f5d177a3fdce2de8ced7fbf353d91e43` and
`c97e91d40570d85076796709fc8304909afe4fcb`. All three are verified present in
the local control-plane checkout.

**No candidate pair is certified.** The only pair this repository pins is
Adea `85be87e3…` with control-plane `1aa42ff2…`, and the control-plane side of
that pair is a _pinned revision of the consumer contract_, not a published
candidate head. CP #943 has no pull request at all, so no control-plane
candidate can be named for it. The `cross-product` gate therefore reports the
missing artifact exactly rather than naming a pair that does not exist.

### The candidate heads named by the #1224 readiness record

All of them are present as objects in this checkout, and **none of them is an
ancestor of the candidate**. They are the draft heads that were measured on
2026-10-10: available to read, and not usable as candidates.

| Candidate | Head                                       | In candidate | Usable as a candidate   |
| --------- | ------------------------------------------ | ------------ | ----------------------- |
| pr-1227   | `065590ae673ad44b958cb297e79eb086118549d7` | no           | no                      |
| pr-1228   | `8e2fa11dcc2b19ef55e6def3953649f1189325eb` | no           | no                      |
| pr-1229   | `c1c02f907cf4cf57a4250737c6bbc98c560661c3` | no           | no                      |
| pr-1230   | `379475c3b53d816b9baaabdbd331ecdfe5e9af65` | no           | no                      |
| pr-1232   | `ab555698c1cc099f7dba0ad7113169ce1bdded59` | no           | no                      |
| pr-1237   | `472977e18f4dcecd975845c11a6ef45f4da3cffd` | no           | no                      |
| pr-1241   | `4b584cc044ceeccd7952e79940aadcfbef17dbb3` | no           | no                      |
| pr-1243   | `eca30d0ed95d28b7d5b026bfeeace1b362a5f052` | no           | no                      |
| pr-1244   | `b45181d58b0e1883c0b180caec2a2866e1a3dee4` | no           | no                      |
| pr-1245   | `782814ad0ce50e325451c332e09a60efcbdae301` | no           | no                      |
| pr-1209   | merged before the readiness record         | yes          | merged, not a candidate |
| pr-1236   | `40f54c826aa31de022b8596ec9c379bb61c132a8` | yes          | merged, not a candidate |
| pr-1238   | `449568904e99718cf52e63fadad6dac58db7e277` | yes          | merged, not a candidate |

### The candidates this certification depends on

| Candidate                | Head | Why it is unavailable                                                                |
| ------------------------ | ---- | ------------------------------------------------------------------------------------ |
| #1181 (Pi Durable)       | —    | no exact head is pinned in this checkout                                             |
| #1182 (export/residency) | —    | no exact head is pinned in this checkout                                             |
| #1177 (UI)               | —    | UI evidence is Claude's; no head is pinned here                                      |
| #1180 (group authority)  | —    | no exact head is pinned in this checkout                                             |
| CP #943 (control plane)  | —    | the control-plane remote publishes no `refs/pull/943/head`; there is no head to name |

The candidate artifact manifest is the only way a packaged or deployed
candidate enters the runner. Its expected path is
`docs/plans/m18-candidate-artifacts.json`; it is **absent**, so the runner
reports the candidate set as `missing` rather than as an empty list. A missing
manifest, a manifest that pins another base, a manifest with a contract the
evidence manifest does not declare, a candidate whose commit is not in the
checkout, an artifact whose digest does not match, and a candidate that names
an unknown id are each rejected with their own reason. A candidate whose
artifacts are helper or fixture modules is rejected as an overclaim: it proves
that a test double works, never that the product does.

## The candidate evidence map

Every id in the #1225 universe appears. `Commit` is the commit the evidence is
bound to, `Package` is the owning workspace package at that commit, and
`Disposition` is the disposition of that evidence at the candidate.

The table is the state **after** the journeys ran, that is, the state of
`bun scripts/evidence-candidate-certification.mjs --run --json`. Without
`--run` the same runner reports the pre-journey state, where nothing is
`passed`, because the pinned receipt is then the only evidence there is and it
binds a revision 270 commits behind the candidate.

### Acceptance ids A01-A40

| Id  | Class                  | Commit     | Package                        | Test                                                               | Disposition   |
| --- | ---------------------- | ---------- | ------------------------------ | ------------------------------------------------------------------ | ------------- |
| A01 | source                 | `73e444f5` | `@adea-ai/workspace-ui@0.99.0` | `packages/workspace-ui/tests/unit/lead-conversation-model.test.ts` | `passed`      |
| A02 | —                      | `—`        | —                              | —                                                                  | `unavailable` |
| A03 | —                      | `—`        | —                              | —                                                                  | `unavailable` |
| A04 | source                 | `73e444f5` | `@adea-ai/data@0.99.0`         | `packages/data/tests/unit/account-directory-keys.test.ts`          | `passed`      |
| A05 | —                      | `—`        | —                              | —                                                                  | `unavailable` |
| A06 | —                      | `—`        | —                              | —                                                                  | `unavailable` |
| A07 | source                 | `73e444f5` | `@adea-ai/data@0.99.0`         | `packages/data/tests/unit/events-audience.test.ts`                 | `passed`      |
| A08 | —                      | `—`        | —                              | —                                                                  | `unavailable` |
| A09 | disposable-integration | `73e444f5` | `@adea-ai/db@0.99.0`           | `packages/db/tests/unit/artifact-reference-policy.test.ts`         | `passed`      |
| A10 | —                      | `—`        | —                              | —                                                                  | `unavailable` |
| A11 | source                 | `73e444f5` | `@adea-ai/web@0.99.0`          | `apps/web/test/agent-profile-pin.test.ts`                          | `passed`      |
| A12 | —                      | `—`        | —                              | —                                                                  | `skipped`     |
| A13 | —                      | `—`        | —                              | —                                                                  | `skipped`     |
| A14 | —                      | `—`        | —                              | —                                                                  | `unavailable` |
| A15 | —                      | `—`        | —                              | —                                                                  | `unavailable` |
| A16 | source                 | `73e444f5` | `@adea-ai/web@0.99.0`          | `apps/web/test/lead-turn-runtime.test.ts`                          | `passed`      |
| A17 | —                      | `—`        | —                              | —                                                                  | `unavailable` |
| A18 | source                 | `73e444f5` | `@adea-ai/web@0.99.0`          | `apps/web/test/lead-turn-runtime.test.ts`                          | `passed`      |
| A19 | —                      | `—`        | —                              | —                                                                  | `skipped`     |
| A20 | source                 | `73e444f5` | `@adea-ai/web@0.99.0`          | `apps/web/test/lead-turn-sdk-adapter.test.ts`                      | `passed`      |
| A21 | —                      | `—`        | —                              | —                                                                  | `untestable`  |
| A22 | —                      | `—`        | —                              | —                                                                  | `skipped`     |
| A23 | source                 | `73e444f5` | `@adea-ai/data@0.99.0`         | `packages/data/tests/unit/mutations-audience.test.ts`              | `passed`      |
| A24 | source                 | `73e444f5` | `@adea-ai/data@0.99.0`         | `packages/data/tests/unit/events-audience.test.ts`                 | `passed`      |
| A25 | —                      | `—`        | —                              | —                                                                  | `skipped`     |
| A26 | —                      | `—`        | —                              | —                                                                  | `unavailable` |
| A27 | source                 | `73e444f5` | `@adea-ai/desktop@0.99.0`      | `apps/desktop/tests/workspace-local-data.test.ts`                  | `passed`      |
| A28 | —                      | `—`        | —                              | —                                                                  | `skipped`     |
| A29 | source                 | `73e444f5` | `@adea-ai/web@0.99.0`          | `apps/web/test/lead-product-reader.test.ts`                        | `passed`      |
| A30 | source                 | `73e444f5` | `@adea-ai/db@0.99.0`           | `packages/db/tests/unit/migration-snapshot-comparator.test.ts`     | `passed`      |
| A31 | —                      | `—`        | —                              | —                                                                  | `unavailable` |
| A32 | —                      | `—`        | —                              | —                                                                  | `unavailable` |
| A33 | —                      | `—`        | —                              | —                                                                  | `unavailable` |
| A34 | source                 | `73e444f5` | `@adea-ai/web@0.99.0`          | `apps/web/test/agent-profile-availability.test.ts`                 | `passed`      |
| A35 | source                 | `73e444f5` | `@adea-ai/web@0.99.0`          | `apps/web/test/desktop-workspace-deletion.test.ts`                 | `passed`      |
| A36 | —                      | `—`        | —                              | —                                                                  | `unavailable` |
| A37 | —                      | `—`        | —                              | —                                                                  | `skipped`     |
| A38 | source                 | `73e444f5` | `@adea-ai/desktop@0.99.0`      | `apps/desktop/tests/dev-runtime-deny-policy.test.ts`               | `passed`      |
| A39 | source                 | `73e444f5` | `@adea-ai/workspace-ui@0.99.0` | `packages/workspace-ui/tests/unit/lead-model-state.test.ts`        | `passed`      |
| A40 | source                 | `73e444f5` | `@adea-ai/workspace-ui@0.99.0` | `packages/workspace-ui/tests/unit/lead-turn-state.test.ts`         | `passed`      |

### Requirement ids

| Id      | Class  | Commit     | Package                        | Test                                                                    | Disposition   |
| ------- | ------ | ---------- | ------------------------------ | ----------------------------------------------------------------------- | ------------- |
| REQ-005 | source | `73e444f5` | `@adea-ai/web@0.99.0`          | `apps/web/test/agent-profile-availability.test.ts`                      | `passed`      |
| REQ-012 | —      | `—`        | —                              | —                                                                       | `untestable`  |
| REQ-033 | —      | `—`        | —                              | —                                                                       | `unavailable` |
| REQ-059 | source | `73e444f5` | `@adea-ai/desktop@0.99.0`      | `apps/desktop/tests/workspace-local-data.test.ts`                       | `passed`      |
| REQ-108 | source | `73e444f5` | `@adea-ai/workspace-ui@0.99.0` | `packages/workspace-ui/tests/unit/lead-model-state.test.ts`             | `passed`      |
| REQ-118 | source | `73e444f5` | `@adea-ai/workspace-ui@0.99.0` | `packages/workspace-ui/tests/unit/lead-model-state.test.ts`             | `passed`      |
| REQ-119 | source | `73e444f5` | `@adea-ai/web@0.99.0`          | `apps/web/test/agent-profile-availability.test.ts`                      | `passed`      |
| REQ-120 | —      | `—`        | —                              | —                                                                       | `skipped`     |
| REQ-130 | source | `73e444f5` | `@adea-ai/workspace-ui@0.99.0` | `packages/workspace-ui/tests/unit/lead-turn-presentation.test.ts`       | `passed`      |
| REQ-131 | source | `73e444f5` | `@adea-ai/workspace-ui@0.99.0` | `packages/workspace-ui/tests/unit/composer-submission-identity.test.ts` | `passed`      |
| REQ-132 | source | `73e444f5` | `@adea-ai/workspace-ui@0.99.0` | `packages/workspace-ui/tests/unit/lead-turn-state.test.ts`              | `passed`      |
| REQ-133 | —      | `—`        | —                              | —                                                                       | `skipped`     |
| REQ-134 | source | `73e444f5` | `@adea-ai/workspace-ui@0.99.0` | `packages/workspace-ui/tests/unit/lead-turn-state.test.ts`              | `passed`      |
| REQ-135 | —      | `—`        | —                              | —                                                                       | `skipped`     |
| REQ-136 | —      | `—`        | —                              | —                                                                       | `unavailable` |
| REQ-150 | —      | `—`        | —                              | —                                                                       | `unavailable` |
| REQ-151 | —      | `—`        | —                              | —                                                                       | `unavailable` |
| REQ-153 | —      | `—`        | —                              | —                                                                       | `unavailable` |
| REQ-154 | —      | `—`        | —                              | —                                                                       | `unavailable` |
| REQ-155 | —      | `—`        | —                              | —                                                                       | `unavailable` |
| REQ-174 | source | `73e444f5` | `@adea-ai/db@0.99.0`           | `packages/db/tests/unit/migration-snapshot-comparator.test.ts`          | `passed`      |
| REQ-175 | —      | `—`        | —                              | —                                                                       | `skipped`     |
| REQ-176 | —      | `—`        | —                              | —                                                                       | `unavailable` |
| REQ-177 | —      | `—`        | —                              | —                                                                       | `unavailable` |

### The 36 rows the manifest maps no evidence for

| Id                                                                            | Disposition   | Readiness criteria that name it                                       | The gap (manifest text)                                                                              | Subject searched             | Lead found (lane)                                                                                                                                                                       |
| ----------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REQ-012                                                                       | `untestable`  | —                                                                     | no alternate lead backend is offered in product; only the candidate adapter is tested                | alternate, responsiveness    | `apps/web/e2e/chat-view.spec.ts` (not-runnable); `apps/web/e2e/direct-session-handoff.spec.ts` (not-runnable)                                                                           |
| REQ-033                                                                       | `unavailable` | —                                                                     | no test asserts use of the shared @adea-ai/ui components rather than local controls                  | controls, evidenced          | `apps/web/e2e/conventional-workspace.spec.ts` (not-runnable); `apps/web/e2e/helpers/source-control-harness-app.tsx` (not-runnable)                                                      |
| REQ-120                                                                       | `skipped`     | —                                                                     | no profile capability matrix exists in merged source; no test asserts per-profile evidence           | matrix                       | `apps/desktop/tests/dev-runtime-connections-launch.test.ts` (source)                                                                                                                    |
| REQ-133                                                                       | `skipped`     | —                                                                     | provider failure preserving draft, transcript and job receipts is not tested end to end              | preserving, billing          | `apps/desktop/tests/dev-runtime-checkpoints.test.ts` (source); `apps/web/test/control-plane-child-joined/README.md` (not-runnable)                                                      |
| REQ-135                                                                       | `skipped`     | ACC-02 (e2e), ACC-07 (not-measured)                                   | keyboard traversal, focus return and status announcements are not asserted by any unit or E2E test i | announcements, audit         | `apps/web/e2e/dev-view-a11y-certification.spec.ts` (not-runnable); `apps/desktop/tests/dev-runtime-git-watcher-dispatch.test.ts` (source)                                               |
| REQ-136                                                                       | `unavailable` | ACC-01 (axe), ACC-03 (presence), ACC-04 (not-measured), ACC-05 (unit) | contrast, zoom, reduced motion and color-only status are not asserted by a test                      | contrast, executed           | `apps/web/e2e/conventional-workspace.spec.ts` (not-runnable); `apps/web/test/integration/retention-cleanup-executor.test.ts` (disposable-integration)                                   |
| REQ-150                                                                       | `unavailable` | COST-03 (presence), COST-08 (not-claimed)                             | no budget reservation, child allocation or per-request enforcement exists in merged source or tests  | enforcement                  | `apps/web/test/control-plane-child-joined/README.md` (not-runnable)                                                                                                                     |
| REQ-151                                                                       | `unavailable` | COST-04 (presence), COST-06 (unavailable)                             | estimate, reserved, reported, reconciled and settled cost states are not represented by a tested sou | represented                  | `apps/web/e2e/chat-view.spec.ts` (not-runnable)                                                                                                                                         |
| REQ-153                                                                       | `unavailable` | OPS-02 (presence)                                                     | the source measures Dev resource metrics, not admission latency, approval age or duplicate suppressi | suppression, instrumentation | `apps/desktop/tests/dev-runtime-composition.test.ts` (source); `apps/desktop/tests/dev-runtime-browser-engine.test.ts` (source)                                                         |
| REQ-154                                                                       | `unavailable` | OPS-03 (presence)                                                     | no lead admission stop by backend or profile is tested                                               | backend, auditable           | `apps/desktop/tests/dev-runtime-browser-engine.test.ts` (source); `apps/web/test/contracts/lead-product-current.fenced-v2-operator.json` (not-runnable)                                 |
| REQ-155                                                                       | `unavailable` | COST-05 (unavailable), COST-07 (presence)                             | active-object time, storage writes and service consumption are not measured by any source or test    | consumption                  | `apps/desktop/tests/dev-runtime-vault.test.ts` (source)                                                                                                                                 |
| REQ-175                                                                       | `skipped`     | OPS-05 (presence)                                                     | no routing-back test to the previous supported path                                                  | routing, compatible          | `scripts/fresh-postgres-acceptance/policy.test.mjs` (not-runnable); `packages/db/tests/integration/migration-populated-rollback-outcome-qualification.test.ts` (disposable-integration) |
| REQ-176                                                                       | `unavailable` | OPS-06 (not-measured)                                                 | the cleanup fence is for deletion, not lead attempt ownership                                        | ownership, fenced            | `apps/desktop/tests/dev-runtime-resources.test.ts` (source); `apps/desktop/tests/dev-runtime-composition.test.ts` (source)                                                              |
| REQ-177                                                                       | `unavailable` | —                                                                     | no destructive cleanup gate or restoration-limit test exists in merged source                        | restoration                  | `apps/desktop/tests/dev-runtime-resources.test.ts` (source)                                                                                                                             |
| A02                                                                           | `unavailable` | —                                                                     | retried topic creation returning the original id is not tested                                       | topic                        | `packages/db/tests/integration/lead-turn-historical.test.ts` (disposable-integration)                                                                                                   |
| A03                                                                           | `unavailable` | —                                                                     | separate private and group runtime contexts are not tested                                           | contexts, leakage            | `apps/web/e2e/conventional-workspace.spec.ts` (not-runnable); `apps/web/e2e/chat-canvas.spec.ts` (not-runnable)                                                                         |
| A05                                                                           | `unavailable` | COST-01 (unit)                                                        | same-name Agents from different workspaces are not tested                                            | different                    | `apps/web/e2e/conventional-workspace.spec.ts` (not-runnable)                                                                                                                            |
| A06                                                                           | `unavailable` | —                                                                     | invitation without enlistment authority is not tested; the group test covers grant revocation metada | invitation                   | `packages/db/tests/integration/group-channels.test.ts` (disposable-integration)                                                                                                         |
| A08                                                                           | `unavailable` | —                                                                     | bounded explicit dispatch with no broadcast feedback loop is not tested                              | broadcast                    | `apps/desktop/tests/dev-runtime-composition.test.ts` (source)                                                                                                                           |
| A10                                                                           | `unavailable` | COST-01 (unit)                                                        | Home protection and blank-workspace no-charge setup are not tested                                   | charge                       | `apps/desktop/tests/dev-runtime-machine-resources.test.ts` (source)                                                                                                                     |
| A12                                                                           | `skipped`     | COST-01 (unit)                                                        | a direct session inspected from Dev and Chat as one canonical session is not tested                  | inspected                    | `apps/desktop/tests/managed-clone.test.ts` (source)                                                                                                                                     |
| A13                                                                           | `skipped`     | —                                                                     | attach, review, hand-off and return with controller audit are not tested                             | controller                   | `apps/web/e2e/chat-canvas.spec.ts` (not-runnable)                                                                                                                                       |
| A14                                                                           | `unavailable` | —                                                                     | writer lease and conflict handling are not tested                                                    | handling, scenario           | `apps/desktop/tests/dev-runtime-follow-ups.test.ts` (source); `apps/desktop/tests/cleanup-gate-parity.test.ts` (source)                                                                 |
| A15                                                                           | `unavailable` | —                                                                     | admitting two children while receiving human input is not tested                                     | receiving                    | `apps/desktop/tests/dev-runtime-computeruse.test.ts` (source)                                                                                                                           |
| A17                                                                           | `unavailable` | —                                                                     | aborting the lead with a queued child completion is not tested                                       | aborting                     | `apps/desktop/tests/dev-runtime-follow-ups.test.ts` (source)                                                                                                                            |
| A19                                                                           | `skipped`     | —                                                                     | approval pending across restart, expiry or changed input is not tested for lead work                 | expiry                       | `apps/desktop/tests/dev-runtime-interactions.test.ts` (source)                                                                                                                          |
| A21                                                                           | `untestable`  | —                                                                     | truthful degraded display for an adapter lacking resume, usage or confirmed cancel is not tested     | lacking                      | `apps/desktop/tests/dev-runtime-composition.test.ts` (source)                                                                                                                           |
| A22                                                                           | `skipped`     | —                                                                     | subscription quota exhaustion and auth-mode change are not tested                                    | exhaustion                   | `apps/web/test/fixtures/source-contracts/source/model-connections.ts.snapshot` (not-runnable)                                                                                           |
| A25                                                                           | `skipped`     | ACC-01 (axe), ACC-02 (e2e), ACC-07 (not-measured)                     | screen reader, keyboard, zoom and reduced-motion checks are not asserted by a test                   | reduced                      | `apps/web/e2e/chat-canvas.spec.ts` (not-runnable)                                                                                                                                       |
| A26                                                                           | `unavailable` | —                                                                     | no budget reservation, child allocation or per-request enforcement exists in merged source or tests  | enforcement, compaction      | `apps/web/test/control-plane-child-joined/README.md` (not-runnable); `apps/web/test/control-plane-child-joined/host.mjs` (not-runnable)                                                 |
| A28                                                                           | `skipped`     | —                                                                     | no typed JSON artifact workflow runtime was located in packages or apps at the pinned SHA            | located                      | `apps/web/e2e/conventional-workspace.spec.ts` (not-runnable)                                                                                                                            |
| A31                                                                           | `unavailable` | OPS-06 (not-measured)                                                 | rollback with active new and old work and uncertain effects is not tested                            | uncertain                    | `apps/web/test/control-plane-joined/lead-fence-v2.test.ts` (source)                                                                                                                     |
| A32                                                                           | `unavailable` | —                                                                     | no LangGraph references were found in packages or apps at the pinned SHA; removal of Cloud services  | langgraph, readability       | `apps/desktop/tests/dev-runtime-composition.test.ts` (source); `apps/desktop/tests/dev-runtime-checkpoints.test.ts` (source)                                                            |
| A33                                                                           | `unavailable` | —                                                                     | lead-tool management of configuration, memory, projects, worktrees and sessions is not tested        | management, sharing          | `apps/desktop/tests/dev-runtime-composition.test.ts` (source); `packages/db/tests/integration/group-channels.test.ts` (disposable-integration)                                          |
| A36                                                                           | `unavailable` | OPS-09 (presence)                                                     | native cross-device history sync absence and supported-state reconnect are not tested                | absence                      | `apps/web/e2e/conventional-workspace.spec.ts` (not-runnable)                                                                                                                            |
| A37                                                                           | `skipped`     | —                                                                     | native hooks, MCP, shell and network effects with changed configuration are not tested               | effects, insufficient        | `apps/desktop/tests/dev-runtime-call-events.test.ts` (source); `apps/desktop/tests/dev-runtime-call-events.test.ts` (source)                                                            |
| The `untestable` rows are the strong findings: the row's subject word appears |
| in **no test file in the repository at the candidate**. A21 (_lacking_) and   |
| REQ-012 (_responsiveness_) have no trace of their subject anywhere. These are |
| genuine feature gaps that need a new test or a decision, not a re-run. Three  |
| rows left this class when the other owners' merges landed: A15 (_receiving_), |
| A32 (_langgraph_, _readability_) and A37 (_insufficient_) now have a passing  |
| qualification.                                                                |

The `unavailable` rows are the ones whose evidence **exists and passes** at the
candidate but is not mapped by the evidence manifest. The qualification exists
and the row is still not certified, because only the manifest may map a
criterion to a test and it belongs to another owner. These rows are the
clearest statement of what the next step is: the manifest has to cite the
qualification. 23 rows are in this class, and most of them became available
when the other owners' merges landed.

The `skipped` rows have a lead in a lane this runner does not reproduce: a
Playwright specification, a fixture or helper module, a script-lane test, or a
file the repository runs in a lane of its own. The runner names the lead and
its lane rather than running it with the wrong runner, because running a
Playwright specification with `bun test` reports a lane mismatch as a behaviour
failure.

## The readiness criteria, measured at the candidate

The #1224 readiness inventory defines twelve presence probes over product
source. The runner executes them **at the frozen candidate**, with the
semantics the merged readiness script uses. A presence probe is a search, not a
proof: it shows that an identifier is or is not in product source at that
commit.

| Criterion | Probe                | Result at `85be87e3` | Files | Owner  |
| --------- | -------------------- | -------------------- | ----- | ------ |
| ACC-03    | reduced-motion-tests | **present**          | 17    | Claude |
| COST-03   | budget-reservation   | **absent**           | 0     | root   |
| COST-04   | budget-reservation   | **absent**           | 0     | root   |
| COST-07   | langgraph-references | **absent**           | 0     | root   |
| OPS-01    | redaction-tests      | **present**          | 53    | —      |
| OPS-02    | metric-identifiers   | **absent**           | 0     | root   |
| OPS-03    | operator-controls    | **absent**           | 0     | root   |
| OPS-04    | feature-flags        | **absent**           | 0     | root   |
| OPS-05    | rollback-code        | **present**          | 3     | —      |
| OPS-08    | retention-gate       | **absent**           | 0     | —      |
| OPS-09    | export-residency     | **present**          | 3     | —      |
| OPS-10    | rollout-runbooks     | **present**          | 3     | —      |

This is the source-of-truth result for the operations and cost criteria: at the
candidate, **there is no budget-reservation, operator-control, feature-flag,
metric-identifier, retention-gate or LangGraph reference in product source**.
The seven absences are the concrete, verifiable form of the cost and
operations gaps, and they are why REQ-150, REQ-151, REQ-153, REQ-154 and REQ-155
cannot be closed by a test run.

## Journeys

Five journeys are available without a release, and all of them are non-UI. The
`source` journey runs the cited tests in a clean checkout of the candidate; the
`discovered` journey runs the qualifications the search found in the
repository's own unit lane; the `browser-condition` journey runs the
browser-condition cited test; the `disposable-integration` journey runs the
database-backed tests against a disposable loopback database; and the
`cross-product` journey runs the joined proof against the control-plane revision
this repository already pins. A sixth journey, `package-consumer`, packs the
packages the source journey built and installs them into a throwaway consumer.

The clean checkout is produced with `git archive`, and the runner verifies that
the exported tree is exactly the candidate's tree (3 246 files, no missing and
no extra path) before it runs anything in it. A test that value-imports a
workspace package needs that package's built artifact, so the packages the lane
needs are built from the same commit, with each package's own `build` script,
before any test runs. This is the same order the repository's own test task
uses (`test` after the package's own `build`).

Every journey is invoked with the source candidate, so the record never mixes
the product source with this work's own files:

```
bun scripts/evidence-candidate-certification.mjs --run --json \
  --base 85be87e3f9e9da0d5cde917c4faf37b7b364b693 \
  --database-url "postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:55473/agent_hq?sslmode=disable" \
  --database-migration-url "postgresql://agent_hq_local_migration:agent_hq_local_migration@127.0.0.1:55473/agent_hq?sslmode=disable" \
  --control-plane-source <a control-plane checkout at 1aa42ff20c7fe1b0d9cc484983a7a631f4589746>
```

### Journey 1: clean checkout (source class)

| Step                      | Command                                                                                       | Exit             | Result                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------- |
| export the tree           | `git archive --format=tar 85be87e3f9e9da0d5cde917c4faf37b7b364b693`                           | 0                | 3 246 files, matching the commit tree exactly                                    |
| install dependencies      | workspace packages linked into the checkout, third-party entries linked to the installed tree | 0                | 15 workspace trees linked                                                        |
| build the needed packages | `bun run build` (cwd the packages the lane needs)                                             | 0                | from the same commit                                                             |
| run the cited tests       | `bun test <file> --reporter=junit --reporter-outfile=<tmp>/junit/<file>.xml`                  | 0 for every file | **24 files, 369 testcases, 0 failures**                                          |
| package-consumer          | `bun pm pack --destination <tmp>` then `bun add <tarball>`                                    | 0                | `@adea-ai/types` installed as `0.99.0` with every declared export target present |

The lane covered **24 of the 27** test files the manifest cites. The three it
leaves out are `apps/web/test/account-directory-pages.test.ts` (the
browser-condition file, run in journey 3), and the two database-backed
integration files (run in journey 4).

### Journey 2: discovered qualifications (source class)

The search for a row's subject found files the manifest does not cite. The
runner runs the ones that the repository's own unit lane runs, in the same
clean checkout.

| Step                          | Command                                                                      | Exit             | Result                                |
| ----------------------------- | ---------------------------------------------------------------------------- | ---------------- | ------------------------------------- |
| run the discovered unit files | `bun test <file> --reporter=junit --reporter-outfile=<tmp>/junit/<file>.xml` | 0 for every file | **3 files, 65 testcases, 0 failures** |

These are the newly merged owners' tests, and they are what moved five rows
out of `untestable` and twenty-three rows into `unavailable`.

### Journey 3: browser condition

The browser-condition file is a unit test of page modules under the browser
export condition. It needs no browser process and no rendered surface, so it is
a test-only qualification and not the UI evidence itself. The **UI evidence
gate stays open** for the rows it touches.

| Step               | Command                                                                                                                 | Exit | Result                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------- |
| run the cited test | `bun test --conditions=browser apps/web/test/account-directory-pages.test.ts --reporter=junit --reporter-outfile=<tmp>` | 0    | **16 testcases, 0 failures** |

This is the established repository command, from the cited receipt itself. It
is run in the clean checkout of the candidate, with the candidate's own built
packages. **A04 and REQ-130 are `passed` because of it.** No UI source was
edited and no UI implementation was taken over.

### Journey 4: disposable integration

The database is disposable and local. It was started under its own Compose
project and port, so it cannot touch another worker's instance, and it was
removed again afterwards. The pinned image was already in the local store, so
this run made no registry request.

```
ADEA_POSTGRES_PORT=55473 docker-compose -p f3w5-cert -f compose.yml up -d postgres
DATABASE_URL=... DATABASE_MIGRATION_URL=... bun run --cwd packages/db db:migrate
# Migration verification passed (61 applied migration(s))
```

| Step                                               | Command                                                                                                | Exit             | Result                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------- | --------------------------------------- |
| run the cited and discovered database-backed files | `bun test --conditions=react-server --timeout 120000 <file> --reporter=junit --reporter-outfile=<tmp>` | 0 for every file | **34 files, 681 testcases, 0 failures** |

The lane refuses any database URL that is not a loopback host, and the
repository's own test-target guard refuses a non-local target as well.

### Journey 5: the joined cross-product proof

This repository already commits a cross-repository pin:
`apps/web/test/control-plane-joined/control-plane-source.json` names the
control-plane revision the joined proof runs against. The runner reads that
committed pin; it never names a pair of its own.

| Step                                        | Command                                                                                                                        | Exit | Result                                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------------------- |
| check out the pinned control-plane revision | `git clone --shared --no-checkout <control-plane> <tmp>` then `git checkout --detach 1aa42ff20c7fe1b0d9cc484983a7a631f4589746` | 0    | HEAD is the pinned revision, the tree is clean, and it contains the fence-v2 consumer `c97e91d40570d85076796709fc8304909afe4fcb` |
| run the joined proof                        | `bun test --conditions=react-server --timeout 120000 apps/web/test/control-plane-joined` (cwd the control-plane checkout)      | 0    | **41 tests, 0 failures, 2 274 assertions**                                                                                       |

The pair that was exercised is a **verified** pair, and both of its ends come
from an existing authorized source:

| Side          | SHA                                        | Source of the SHA                                           |
| ------------- | ------------------------------------------ | ----------------------------------------------------------- |
| Adea          | `85be87e3f9e9da0d5cde917c4faf37b7b364b693` | `refs/heads/main` of `adea-ai/adea`                         |
| Control plane | `1aa42ff20c7fe1b0d9cc484983a7a631f4589746` | this repository's own committed `control-plane-source.json` |

This is a source-level proof that the two repositories agree on the fence-v2
contract. It is **not** a candidate qualification and **not** production
qualification: the control-plane side is a pinned consumer-contract revision,
not a published candidate head, and the `cross-product` gate stays open for
that reason. The proof's own record says the same:
`docs/evidence/m18-01-3-joined-consumer-proof.md`.

Two conditions apply. The proof needs a **fresh disposable database**: it
writes rows under fixed identifiers, so a database that already holds them
makes it fail, and the runner reports that failure with the reason rather than
calling it a pass. And the `turbo` CLI appends a managed agent-guidance block
to `AGENTS.md` in the control-plane checkout when it detects an agent, which
the proof refuses as a tracked change; the block is restored before the proof
runs. Both are effects in a temporary clone, not in any owner's checkout.

## What was repaired in the owned harness

Three defects in this runner's own lanes were found and repaired. Each was
found by running the runner, and each is covered by a focused test.

| Defect                                                                                                                                                                                                                                                  | Repair                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A discovered qualification was never run when it was database-backed, so the newly merged owners' integration tests were named but not executed.                                                                                                        | The discovered files are split by the lane that can run them, and the database-backed ones join the disposable lane.                                                                                                                             |
| A discovered file was run even when **no lane of this repository runs it** (a desktop-shell test, a dev-view test, a script-lane test). In the wrong lane those files failed for environment reasons, and the runner reported them as product failures. | The lanes are read from the repository's own definitions: the `test:coverage` path list for the unit lane, and `scripts/integration-inventory.mjs` for the integration lane. A file no lane runs is named with that reason instead of being run. |
| A file that demands the **Docker capture provisioning** (`MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL`) was run without it and failed. Those files refuse to skip silently, and the failure is a missing prerequisite, not a behaviour.                     | They are detected from their own source and named with the exact prerequisite. Nine files are in this class, including the five migration qualifications that #1545 merged.                                                                      |

A fourth rule was added for the same reason: a file whose every test timed out
did not run, and is now reported as a skip rather than as a failure.

The result is that **every journey passes and no failure is reported that is
not a product failure**. The 83 qualifications that no lane here can run are
named, with the reason, in the report's `unrunnableQualifications`.

## The wider repository lane

The documented wider command is `bun test scripts/`.

**The aggregate lane was not re-run for this reconciliation.** The runs
recorded below are the raw receipts of the previous round, they are the
evidence for the wider lane, and they were not repeated: the shared capacity
is not certified, a repeated aggregate run would add load without adding
evidence, and the Docker registry's anonymous pull limit makes the aggregate
lane's provisioning steps unreliable on this host. The focused tests for this
work were run instead, and the diagnosis below stands on the raw receipts.

### The missing Node runtime was an environment gap, not a waived check

The first run of the wider lane failed 74 tests. The cause was that `node` was
not on `PATH`: this host has no `node` in `PATH`, and the lane's scripts spawn
`node` directly. The repository pins the runtime in two places — `.mise.toml`
(`node = "24.21.0"`) and `package.json` (`"engines": { "node": "24.21.0" }`) —
and **that exact version is already installed on this host** by mise, at
`/Users/amf/.local/share/mise/installs/node/24.21.0/bin/node`. It is an
existing official runtime, not a new one: nothing was installed and no
credential was created. The session's `HOME` is redirected, which is why mise
did not find it.

### The second prerequisite: the built packages

`bun test scripts/` alone does not build the workspace packages, so every
script test that value-imports a workspace package fails with
`Cannot find module '@adea-ai/auth/desktop'`. The repository's own order is
build-then-test (`scripts/orch-graph.mjs`: "test after the package's own
`build`"). With the packages built, those failures disappear.

### The three runs

| Run | Node on `PATH` | Packages built | Result                                                                                         |
| --- | -------------- | -------------- | ---------------------------------------------------------------------------------------------- |
| 1   | no             | no             | 1 405 pass, 2 skip, **74 fail**, exit 1 — `Executable not found in $PATH: "node"` and exit 127 |
| 2   | yes            | no             | 1 433 pass, 2 skip, **26 fail**, exit 1                                                        |
| 3   | yes            | yes            | **1 456 pass**, 2 skip, **23 fail**, exit 1                                                    |

Run 3 is the widest applicable run on this host:

```
PATH=/Users/amf/.local/share/mise/installs/node/24.21.0/bin:$PATH bun test scripts/
# 1456 pass, 2 skip, 23 fail, 1481 tests across 102 files, 668.08 s
# exit 1
```

The repository's own chain passes at the candidate:

```
PATH=/Users/amf/.local/share/mise/installs/node/24.21.0/bin:$PATH bun run build
# vp run: 0/15 cache hit (0%), 17/17 successful.
# exit 0
```

### The baseline, without the three new files

The same command was run with the three owned files moved out of the tree:

| Run                                   | Files | Result                                  |
| ------------------------------------- | ----- | --------------------------------------- |
| baseline, without the three new files | 101   | 1 386 pass, 2 skip, **18 fail**, exit 1 |
| with the three new files              | 102   | 1 456 pass, 2 skip, **23 fail**, exit 1 |

The three files add 75 tests, and **all 75 pass in the full lane**; no failure
in run 3 belongs to them. The five-failure difference is entirely in other
owners' files, and the failing test _names_ differ between the two runs:

```
(fail) actual Bun runner cleans partial startup and terminates on SIGINT
(fail) lanes that load the guard > Playwright binds the dev Worker and Node fixtures to the same validated database
(fail) real lifecycle helpers preserve test failure when both resource teardowns fail
(fail) shared UI lint configuration > consumer source does not suppress shared UI rules inline
(fail) the packaging job verifier (Verify stable bundle structure) > fails for a payload built as a local or hosted-dev client, or with no record
(fail) the published-assets verifier (Verify uploaded desktop assets) > fails for an archive built as a local or hosted-dev client, or with no record
```

Every one of them is a deadline-sensitive test (a 5 000 ms Bun test timeout, a
compose-up deadline or a release-archive check) that flips with the host load.
Three other fleets' suites were running on the same host during run 3.

The representative failing files were then run in isolation, with the three new
files still moved out, and the same failures appear:

```
PATH=... bun test scripts/integration-runner-lifecycle.test.ts \
  scripts/test-target-guard.test.ts scripts/shared-ui-lint-config.test.ts \
  scripts/release-target-verifier.test.ts scripts/vp-r2-cache-transfer.test.ts
# 122 pass, 2 skip, 2 fail, 124 tests across 5 files
# (fail) the packaging job verifier (Verify stable bundle structure) > passes for a release-built payload, with and without a release version
# (fail) real lifecycle helpers preserve test failure when both resource teardowns fail
# exit 1
```

The remaining failures in the wider lane are therefore **pre-existing on this
host** and are not caused by this work. Their causes are: the shared Docker
registry's anonymous pull limit (`toomanyrequests: Data limit exceeded`) for
the capture-provisioning and fresh-schema lanes, a control-plane SDK module
that is not installed here, a `server-only` import that needs the
`--conditions=react-server` condition, and host-load deadlines.

### The runner's own tests

```
bun test scripts/evidence-candidate-certification.test.ts
# 75 pass, 0 fail, 185 expect() calls
```

### Strict mode

```
bun scripts/evidence-candidate-certification.mjs --strict
# strict: not every id is certified
# exit code 1
```

Strict mode exits non-zero for as long as any id is uncertified, whatever the
reason. The rule is a pure function of the report and is covered by tests for
all three cases: a plain run exits 0 while ids are uncertified, a strict run
exits 1 while ids are uncertified, and a strict run exits 0 only when every id
is certified. An unknown option is refused rather than silently shifting the
manifest path.

## The nine external gates

These gates are open for every id. They are external to this repository, so
this record reports the exact missing artifact and its owner and never infers
them.

| Gate                      | Owner                | The exact missing artifact                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `native-candidate`        | candidate owners     | An exact head for #1181, #1182, #1177 or #1180, and a native artifact built from it. No such head is pinned in this checkout, and the remote's open drafts (#1515, #1518, #1522, #1525) are drafts, not candidates.                                                                                                                                                                                                        |
| `control-plane-candidate` | control-plane owners | A control-plane candidate head for CP #943. The control-plane remote publishes **no** `refs/pull/943/head` and no `refs/pull/943/merge`, so there is no head to name. The published control-plane candidate head is `95021f73a1127d117317ed78e5d7466f3ad61783` for CP #1210.                                                                                                                                               |
| `packaged-native`         | release owners       | A packaged or native candidate artifact for the milestone, and the contract version the evidence manifest accepts. `compatibility.contractVersions` is empty, so **every** candidate contract is currently incompatible. This task does not authorize a release.                                                                                                                                                           |
| `deployed`                | release owners       | A deployed environment built from the candidate. None is available, and this task does not authorize access to production.                                                                                                                                                                                                                                                                                                 |
| `cross-product`           | both product owners  | One exact pair of **candidate** heads, one from each repository. The joined journey **was** executed and passed at a verified pair (Adea `85be87e3…` with control-plane `1aa42ff2…`, 41 tests, 0 failures, 2 274 assertions), but the control-plane side of that pair is a pinned consumer-contract revision, not a published candidate head: CP #943 has no pull request, so there is no control-plane candidate to name. |
| `soak-24h`                | release owners       | A 24-hour soak result. Not run here; this task does not authorize long paid or production soaks.                                                                                                                                                                                                                                                                                                                           |
| `performance-cost`        | release owners       | Approved latency and cost thresholds and a meter. The candidate measures none of the eight instrumentation identifiers, so nothing can be measured for them.                                                                                                                                                                                                                                                               |
| `owner-acceptance`        | owner                | The owner's daily-driver journey. A human decision, reported as open and never inferred.                                                                                                                                                                                                                                                                                                                                   |
| `ui-evidence`             | Claude               | The axe audit, the keyboard suite and the screen-reader pass at the candidate, and the reduced-motion, contrast and zoom assertions. The browser-condition unit test is not this evidence.                                                                                                                                                                                                                                 |

## Gap report and routing to root

The gaps below are the concrete, testable feature gaps that the #1225 manifest
records against each id. They are **not** new findings and they are **not** a
defect list: they are the coverage the milestone still owes. The 36-row table
above gives each of them an individual disposition and a searched subject.

The #1225 PRD and TDD are not in this repository, so the id-to-area mapping
comes from the gap text in the merged manifest and from the criterion text in
the merged readiness inventory. **The route is a proposal by feature area; root
confirms the owner.** This work owns none of the paths a gap would need, so
nothing here is edited to close one.

### Root: decide, because no owner can close them alone

| Gap                                                                                                                                                | Ids          | Why it needs root                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| No profile capability matrix exists in merged source; no test asserts per-profile evidence                                                         | REQ-120      | The matrix is a product decision, not a test.                                                                                              |
| No budget reservation, child allocation or per-request enforcement exists in merged source or tests                                                | REQ-150, A26 | Cost enforcement needs an approved budget model. The `budget-reservation` probe is **absent** at the candidate.                            |
| Estimate, reserved, reported, reconciled and settled cost states are not represented by a tested source                                            | REQ-151      | The cost states need a billing contract that does not exist here. The `budget-reservation` probe is **absent**.                            |
| Active-object time, storage writes and service consumption are not measured by any source or test                                                  | REQ-155      | Needs an approved metering definition. The `metric-identifiers` probe is **absent**.                                                       |
| No destructive cleanup gate or restoration-limit test exists in merged source                                                                      | REQ-177      | The gate threshold is a policy decision. The `retention-gate` probe is **absent**.                                                         |
| The cleanup fence is for deletion, not lead attempt ownership; no fenced-owner rollback test exists                                                | REQ-176      | Ownership semantics need root arbitration.                                                                                                 |
| No LangGraph references were found in packages or apps at the pinned SHA; removal of Cloud services is not evidenced                               | A32          | "Removed" is a claim about a dependency, not a test. The `langgraph-references` probe is **absent** and no test file mentions _langgraph_. |
| No typed JSON artifact workflow runtime was located in packages or apps at the pinned SHA                                                          | A28          | The runtime's location has to be confirmed before it can be tested.                                                                        |
| The source measures Dev resource metrics, not admission latency, approval age or duplicate suppression; no Pi-specific instrumentation test exists | REQ-153      | The thresholds need FOUNDATIONS approval, and the `metric-identifiers` probe is **absent**.                                                |
| No alternate lead backend is offered in product; only the candidate adapter is tested                                                              | REQ-012      | Whether a second backend ships is a product decision. No test file mentions _responsiveness_.                                              |
| No lead admission stop by backend or profile is tested; attributed, auditable operator intervention is not tested                                  | REQ-154      | The `operator-controls` probe is **absent** at the candidate.                                                                              |
| No feature-flag or admission-routing identifier is in product source                                                                               | (TDD 18)     | The `feature-flags` probe is **absent**; the rollout sequence has nothing to route on.                                                     |

### Area: Home and workspace lifecycle

| Gap                                                                                                                                                                 | Ids     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Workspace creation, browse, reconnect and transcript open with zero model calls are not tested; the setup test covers only a structural lead without catalog access | REQ-005 |
| Home protection and blank-workspace no-charge setup are not tested                                                                                                  | A10     |

### Area: lead runtime, native sessions and group authority

| Gap                                                                                                                                                                     | Ids     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Pi-usable provider access versus native-only authentication is not distinguished by any test; the Pi Models registry is not exercised                                   | REQ-108 |
| Cross-workspace account reuse and Home credential reuse are not exercised; no admission-time quota or budget check is tested                                            | REQ-118 |
| Specific remedy wording and draft or conversation preservation are not asserted; direct native session availability is not tested                                       | REQ-119 |
| Exactly-one-lead invariant at workspace creation is not tested; identity and history survival through lead designation are not tested                                   | A01     |
| Retried topic creation returning the original id is not tested                                                                                                          | A02     |
| Separate private and group runtime contexts are not tested; transcript and tool-result leakage between chats is not tested                                              | A03     |
| Same-name Agents from different workspaces are not tested                                                                                                               | A05     |
| Invitation without enlistment authority is not tested                                                                                                                   | A06     |
| Participant add and remove and history policy are not tested; late publication redirect is not tested                                                                   | A07     |
| Bounded explicit dispatch with no broadcast feedback loop is not tested                                                                                                 | A08     |
| A group send path is not tested (the exact-version share is covered at policy level and by the two database-backed receipts)                                            | A09     |
| Reconfiguring an Agent during an active attempt is not tested; a future-version change with preserved active authority is not tested                                    | A11     |
| A direct session inspected from Dev and Chat as one canonical session is not tested                                                                                     | A12     |
| Attach, review, hand-off and return with controller audit are not tested                                                                                                | A13     |
| Writer lease and conflict handling are not tested; dirty cleanup refusal is not tested in a worktree-writer scenario                                                    | A14     |
| Admitting two children while receiving human input is not tested                                                                                                        | A15     |
| Crashes at child-send, outcome and publication boundaries are not tested; duplicate-announcement suppression is not tested                                              | A16     |
| Aborting the lead with a queued child completion is not tested                                                                                                          | A17     |
| New-attempt fencing against a late old-attempt event is not tested                                                                                                      | A18     |
| Approval pending across restart, expiry or changed input is not tested for lead work                                                                                    | A19     |
| A crash after an external write before a local receipt is not tested; same-effect identity under reconciliation is not tested                                           | A20     |
| Truthful degraded display for an adapter lacking resume, usage or confirmed cancel is not tested                                                                        | A21     |
| Subscription quota exhaustion and auth-mode change are not tested                                                                                                       | A22     |
| Quota exhaustion after selection is not tested; absence of silent provider or account fallback is asserted only indirectly; reconnect remedy presentation is not tested | A40     |
| Rollback with active new and old work and uncertain effects is not tested                                                                                               | A31     |
| Lead-tool management of configuration, memory, projects, worktrees and sessions is not tested; UI and lead paths sharing one policy are not tested                      | A33     |
| Direct native work remaining available is not tested; no native child signed-in fixture exists                                                                          | A34     |
| Native cross-device history sync absence and supported-state reconnect are not tested                                                                                   | A36     |
| Native hooks, MCP, shell and network effects with changed configuration are not tested; post-hoc events as insufficient evidence are not tested                         | A37     |
| No routing-back test to the previous supported path; no compatible-reader test for the rollback window                                                                  | REQ-175 |
| Device offline waiting state and revalidation on reconnect are not tested; a revoked target generation is not tested end to end                                         | A23     |
| Slow stream and two-tab convergence are not tested; reconnect during deployment is not tested                                                                           | A24     |
| Secret exclusion from recovery, export, logs and context preparation is not tested; reusable credentials in checkpoints and ordinary events are not tested              | A38     |

### Area: export, residency and deletion

| Gap                                                                                                                                          | Ids |
| -------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| Offline executor delete and export with retained evidence is not tested; portable authorized export is not tested                            | A27 |
| Human and lead permanent-deletion paths are not both tested to fail closed; trusted cleanup verification prerequisite is not directly tested | A35 |

### Area: account directory, device and inbox

| Gap                                                                                                                                                                                                                                                      | Ids     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Global inbox counts not leaking across switches are not asserted; authorized-conversation stability under focus is not tested                                                                                                                            | A04     |
| Loading, denied, offline and failed are not distinguished by a test; the empty state is covered only for the global directory and inbox first pages; denied title and participant masking is not tested; empty-workspace creation actions are not tested | REQ-130 |
| Locally unsent, queued and offline-draft states are not tested; job-level duplicate suppression on retry is not tested; reconnect never auto-sending drafts is not tested                                                                                | REQ-131 |

### Area: migration, fencing and rollback

| Gap                                                                                                                                                                                 | Ids     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Separate stop-response, cancel-job and cancel-all controls are not tested; descendant and external-effect explanation is not tested; noncooperative-tool escalation is not tested   | REQ-132 |
| Provider failure preserving draft, transcript and job receipts is not tested end to end; a fallback that changes provider or billing under configured approval policy is not tested | REQ-133 |
| Multiple tabs and slow-client convergence are not tested; reconnect restoring pending approvals is not tested; absence of side-effect replay on reconnect is not tested end to end  | REQ-134 |
| No archived or participant-only channel fixture; read-state and link preservation are not compared; legacy-user denial exists only as comparator findings                           | A30     |
| Resume after a version change or revocation is not tested; the test pins provenance only, not resumption                                                                            | A29     |

### Area: model connections, credentials and runtime profile

| Gap                                                                                                                                                                                                                         | Ids     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Add, inspect, label, authorize, reconnect, revoke and remove flows are not tested as one manager; secure credential entry and the provider sign-in flow are not tested; the detaches test covers only reverse profile links | REQ-059 |
| Harness and location eligibility with workspace grants is not tested in the rendered picker; resolved model and funding display is not verified in rendered UI; the connect-provider flow is not tested                     | A39     |

### Area: UI evidence (Claude)

| Gap                                                                                                                                      | Ids     |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| No test asserts use of the shared `@adea-ai/ui` components rather than local controls; migration #811 is not evidenced in the repository | REQ-033 |
| Keyboard traversal, focus return and status announcements are not asserted by any unit or E2E test in this repository                    | REQ-135 |
| Contrast, zoom, reduced motion and color-only status are not asserted by a test; the WCAG 2.2 AA scope is not recorded as executed       | REQ-136 |
| Screen reader, keyboard, zoom and reduced-motion checks are not asserted by a test                                                       | A25     |

## Reproduce

```sh
# the map, no journeys
bun scripts/evidence-candidate-certification.mjs

# the full JSON report
bun scripts/evidence-candidate-certification.mjs --json

# every journey, at the frozen source candidate
bun scripts/evidence-candidate-certification.mjs --run --json \
  --base 85be87e3f9e9da0d5cde917c4faf37b7b364b693 \
  --database-url "postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:55473/agent_hq?sslmode=disable" \
  --database-migration-url "postgresql://agent_hq_local_migration:agent_hq_local_migration@127.0.0.1:55473/agent_hq?sslmode=disable" \
  --control-plane-source <a control-plane checkout at 1aa42ff20c7fe1b0d9cc484983a7a631f4589746>

# the disposable-integration journey on its own
bun scripts/evidence-candidate-certification.mjs --run \
  --base 85be87e3f9e9da0d5cde917c4faf37b7b364b693 \
  --database-url "postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:55473/agent_hq?sslmode=disable" \
  --database-migration-url "postgresql://agent_hq_local_migration:agent_hq_local_migration@127.0.0.1:55473/agent_hq?sslmode=disable"

# strict mode: exits non-zero unless every id is certified
bun scripts/evidence-candidate-certification.mjs --strict

# the runner's own tests
bun test scripts/evidence-candidate-certification.test.ts

# the documented wider lane, with the repository's pinned Node runtime
PATH=/Users/amf/.local/share/mise/installs/node/24.21.0/bin:$PATH bun test scripts/

# the generic manifest validator, read-only, for comparison
bun scripts/evidence-manifest.mjs --local-only
```

The disposable database this record used was created and removed for the run:

```sh
ADEA_POSTGRES_PORT=55473 docker-compose -p f3w5-cert -f compose.yml up -d postgres
docker-compose -p f3w5-cert -f compose.yml down -v
```

## Limits

- A source-class result proves that a named test passed at one commit in one
  clean checkout on this host. It does not prove the behaviour a criterion
  describes; the mapping between a title and a criterion is a human judgement
  recorded in the manifest's `criteria`.
- A `passed` disposition is not a certification. The certification count is
  zero while the nine gates are open.
- A `skipped` disposition names a file this runner does not run. It is a lead
  for the owner of that lane, not a result.
- The discovery search is mechanical: it finds the files that mention a gap's
  rarest content word. It is evidence of _where_ to look, and never a
  certification that a lead covers a criterion. Only the manifest maps a
  criterion to a test, and the manifest belongs to another owner.
- The readiness presence probes are searches over product source. `present`
  shows that an identifier exists at the candidate; it does not show that the
  behavior works.
- The disposable-integration lane uses a loopback database and refuses any
  other host. It is not a production, staging or shared-database result.
- The package-consumer journey proves that a package packed from the candidate
  installs into a consumer and declares the expected name, version and export
  targets. A package that declares a `workspace:` dependency range is reported
  as `workspace-only`: it cannot be installed by an outside consumer, because
  that range only resolves inside the workspace. Every workspace package except
  `@adea-ai/types`, `@adea-ai/remote-content`, `@adea-ai/audio` and
  `@adea-ai/spatial` is in that state.
- The joined cross-product proof needs a fresh disposable database. A database
  that already holds the proof's fixed identifiers makes it fail, and the
  runner reports that failure rather than calling it a pass.
- A package that a cited test value-imports is built from the same commit
  before the test runs, and the build is part of the record. A source result
  therefore rests on a build that came from the certified commit, not on a
  stale `dist` from the working tree.
- The evidence manifest's own receipts are claims plus runner output in one
  hashed artifact, committed by this repository. Re-running the command at the
  executed revision is the check, and that is what the clean-checkout journey
  does.
- The #1225 PRD and TDD live in Google Docs and are not in this repository. The
  ids, the criteria text and the gap text come from the merged manifest and the
  merged readiness inventory, not from the PRD.

## Draft packet

This document, the runner and the runner's tests are a checked draft packet on
branch `codex/f3w5-adea-20261021`. The branch carries no tracked modification
of another owner's file; the three owned files are the only changes, and the
diff against `main` is exactly those three files.

Draft pull request **#1550** is **open, draft, not merged, auto-merge off**,
with one commit and three changed files, and no failing check. Its head was
`a68e96a75124da98ead6b1543785874ad1c1d2b9` when it was opened; this
reconciliation adds the merge of the current `main` and the harness repairs on
top of it, so the publisher advances the head to the commit named in the
handoff packet.

No credential has been created, nothing has been published or merged, no
readiness or release claim is made, no issue is closed, and no deployment or
production access happened. The exact-head and test manifest is the `entries[]`
array of the JSON report: every one of the 64 ids carries a commit, a package
version, a test path, a test title count, an evidence class and a disposition.
