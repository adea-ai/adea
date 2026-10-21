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
| `skipped`     | 25    | a qualifying test exists and is named, but this runner does not run it         |
| `unavailable` | 6     | the row's evidence needs an artifact, an environment or a head that is missing |
| `untestable`  | 5     | no test file in the repository mentions the row's subject at all               |
| `failed`      | 0     | —                                                                              |

A `passed` disposition is about the **evidence**, not about certification. A row
is certified only when its evidence is bound to the candidate _and_ every
external gate for it is closed, and all nine gates are open.

## The frozen source candidate

| Role                           | Value                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------ |
| Repository                     | `adea-ai/adea`                                                                 |
| Frozen source candidate        | `12a1830c4115eb46503a79aa0701452ac12ec695`                                     |
| Verified from                  | `refs/heads/main` of `adea-ai/adea`, read with the existing remote credentials |
| Package version at that commit | `0.99.0` (root `package.json`) and `0.99.0` (`@adea-ai/types`)                 |
| Branch                         | `codex/f3w5-adea-20261021`                                                     |

The candidate was frozen after the branch was fast-forwarded to the current
`origin/main`. The fast-forward was safe and is recorded: the three owned paths
are **absent** at `origin/main`, the previous head `ee31982e70406ab5de447a79603d6545ac11359f`
is an **ancestor** of `origin/main`, and the three drafts were hashed and
copied byte-for-byte before the merge. The merge was a fast-forward; nothing was
reset, cleaned or overwritten, and the draft hashes are unchanged.

`origin/main` is one commit ahead of the previous base, and that commit is
[#1542](https://github.com/adea-ai/adea/pull/1542) `fix(workspaces): recover
from a reorder conflict and keep a save from being overwritten`. It changes
`apps/web/e2e/workspace-reorder.spec.ts`, `packages/data/src/index.ts` and
`packages/data/tests/unit/workspaces.test.ts`. **None of the 27 cited test
files is among them**, so no cited title was invalidated by the advance. The
cited tests were still re-run at the candidate, because the source under
`packages/data` did change and a test that has not been re-run says nothing
about the new commit.

The evidence manifest's own pin is unchanged at
`e8b75daa5cc996a4c0d84489a3885535c3045a2f`, which is 270 commits behind the
candidate. The manifest is **not** re-pinned: it belongs to another owner, and
re-pinning it would declare the changed behaviors covered without requalifying
them. What this runner does instead is re-run every cited test at the candidate
and report the result.

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
| `refs/heads/main`     | `12a1830c4115eb46503a79aa0701452ac12ec695` | **the frozen source candidate**                     |
| `refs/pull/1515/head` | `312c49db2e77371cf38a5397c386439494e53019` | an open draft, not merged, not a candidate          |
| `refs/pull/1518/head` | `fcb72ad807d95fa82bb9b76801a24b16c0cccb0e` | an open draft, not merged, not a candidate          |
| `refs/pull/1522/head` | `a18e35ff2e213133480811435b47107a68c6e2b3` | an open draft, not merged, not a candidate          |
| `refs/pull/1525/head` | `f37411f4d0aed067c66a37b40d1d30af9bd85a37` | an open draft, not merged, not a candidate          |
| `refs/pull/1542/head` | `fd177baf38ad7e72eb14abd9cb6bfab766f90861` | the pre-merge head of the commit that is now `main` |

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
Adea `12a1830c…` with control-plane `1aa42ff2…`, and the control-plane side of
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
| A01 | source                 | `12a1830c` | `@adea-ai/workspace-ui@0.99.0` | `packages/workspace-ui/tests/unit/lead-conversation-model.test.ts` | `passed`      |
| A02 | —                      | `—`        | —                              | —                                                                  | `skipped`     |
| A03 | —                      | `—`        | —                              | —                                                                  | `skipped`     |
| A04 | source                 | `12a1830c` | `@adea-ai/data@0.99.0`         | `packages/data/tests/unit/account-directory-keys.test.ts`          | `passed`      |
| A05 | —                      | `—`        | —                              | —                                                                  | `skipped`     |
| A06 | —                      | `—`        | —                              | —                                                                  | `unavailable` |
| A07 | source                 | `12a1830c` | `@adea-ai/data@0.99.0`         | `packages/data/tests/unit/events-audience.test.ts`                 | `passed`      |
| A08 | —                      | `—`        | —                              | —                                                                  | `unavailable` |
| A09 | disposable-integration | `12a1830c` | `@adea-ai/db@0.99.0`           | `packages/db/tests/unit/artifact-reference-policy.test.ts`         | `passed`      |
| A10 | —                      | `—`        | —                              | —                                                                  | `skipped`     |
| A11 | source                 | `12a1830c` | `@adea-ai/web@0.99.0`          | `apps/web/test/agent-profile-pin.test.ts`                          | `passed`      |
| A12 | —                      | `—`        | —                              | —                                                                  | `skipped`     |
| A13 | —                      | `—`        | —                              | —                                                                  | `skipped`     |
| A14 | —                      | `—`        | —                              | —                                                                  | `skipped`     |
| A15 | —                      | `—`        | —                              | —                                                                  | `untestable`  |
| A16 | source                 | `12a1830c` | `@adea-ai/web@0.99.0`          | `apps/web/test/lead-turn-runtime.test.ts`                          | `passed`      |
| A17 | —                      | `—`        | —                              | —                                                                  | `skipped`     |
| A18 | source                 | `12a1830c` | `@adea-ai/web@0.99.0`          | `apps/web/test/lead-turn-runtime.test.ts`                          | `passed`      |
| A19 | —                      | `—`        | —                              | —                                                                  | `skipped`     |
| A20 | source                 | `12a1830c` | `@adea-ai/web@0.99.0`          | `apps/web/test/lead-turn-sdk-adapter.test.ts`                      | `passed`      |
| A21 | —                      | `—`        | —                              | —                                                                  | `untestable`  |
| A22 | —                      | `—`        | —                              | —                                                                  | `skipped`     |
| A23 | source                 | `12a1830c` | `@adea-ai/data@0.99.0`         | `packages/data/tests/unit/mutations-audience.test.ts`              | `passed`      |
| A24 | source                 | `12a1830c` | `@adea-ai/data@0.99.0`         | `packages/data/tests/unit/events-audience.test.ts`                 | `passed`      |
| A25 | —                      | `—`        | —                              | —                                                                  | `skipped`     |
| A26 | —                      | `—`        | —                              | —                                                                  | `skipped`     |
| A27 | source                 | `12a1830c` | `@adea-ai/desktop@0.99.0`      | `apps/desktop/tests/workspace-local-data.test.ts`                  | `passed`      |
| A28 | —                      | `—`        | —                              | —                                                                  | `skipped`     |
| A29 | source                 | `12a1830c` | `@adea-ai/web@0.99.0`          | `apps/web/test/lead-product-reader.test.ts`                        | `passed`      |
| A30 | source                 | `12a1830c` | `@adea-ai/db@0.99.0`           | `packages/db/tests/unit/migration-snapshot-comparator.test.ts`     | `passed`      |
| A31 | —                      | `—`        | —                              | —                                                                  | `skipped`     |
| A32 | —                      | `—`        | —                              | —                                                                  | `untestable`  |
| A33 | —                      | `—`        | —                              | —                                                                  | `skipped`     |
| A34 | source                 | `12a1830c` | `@adea-ai/web@0.99.0`          | `apps/web/test/agent-profile-availability.test.ts`                 | `passed`      |
| A35 | source                 | `12a1830c` | `@adea-ai/web@0.99.0`          | `apps/web/test/desktop-workspace-deletion.test.ts`                 | `passed`      |
| A36 | —                      | `—`        | —                              | —                                                                  | `unavailable` |
| A37 | —                      | `—`        | —                              | —                                                                  | `untestable`  |
| A38 | source                 | `12a1830c` | `@adea-ai/desktop@0.99.0`      | `apps/desktop/tests/dev-runtime-deny-policy.test.ts`               | `passed`      |
| A39 | source                 | `12a1830c` | `@adea-ai/workspace-ui@0.99.0` | `packages/workspace-ui/tests/unit/lead-model-state.test.ts`        | `passed`      |
| A40 | source                 | `12a1830c` | `@adea-ai/workspace-ui@0.99.0` | `packages/workspace-ui/tests/unit/lead-turn-state.test.ts`         | `passed`      |

### Requirement ids

| Id      | Class  | Commit     | Package                        | Test                                                                    | Disposition   |
| ------- | ------ | ---------- | ------------------------------ | ----------------------------------------------------------------------- | ------------- |
| REQ-005 | source | `12a1830c` | `@adea-ai/web@0.99.0`          | `apps/web/test/agent-profile-availability.test.ts`                      | `passed`      |
| REQ-012 | —      | `—`        | —                              | —                                                                       | `untestable`  |
| REQ-033 | —      | `—`        | —                              | —                                                                       | `skipped`     |
| REQ-059 | source | `12a1830c` | `@adea-ai/desktop@0.99.0`      | `apps/desktop/tests/workspace-local-data.test.ts`                       | `passed`      |
| REQ-108 | source | `12a1830c` | `@adea-ai/workspace-ui@0.99.0` | `packages/workspace-ui/tests/unit/lead-model-state.test.ts`             | `passed`      |
| REQ-118 | source | `12a1830c` | `@adea-ai/workspace-ui@0.99.0` | `packages/workspace-ui/tests/unit/lead-model-state.test.ts`             | `passed`      |
| REQ-119 | source | `12a1830c` | `@adea-ai/web@0.99.0`          | `apps/web/test/agent-profile-availability.test.ts`                      | `passed`      |
| REQ-120 | —      | `—`        | —                              | —                                                                       | `skipped`     |
| REQ-130 | source | `12a1830c` | `@adea-ai/workspace-ui@0.99.0` | `packages/workspace-ui/tests/unit/lead-turn-presentation.test.ts`       | `passed`      |
| REQ-131 | source | `12a1830c` | `@adea-ai/workspace-ui@0.99.0` | `packages/workspace-ui/tests/unit/composer-submission-identity.test.ts` | `passed`      |
| REQ-132 | source | `12a1830c` | `@adea-ai/workspace-ui@0.99.0` | `packages/workspace-ui/tests/unit/lead-turn-state.test.ts`              | `passed`      |
| REQ-133 | —      | `—`        | —                              | —                                                                       | `skipped`     |
| REQ-134 | source | `12a1830c` | `@adea-ai/workspace-ui@0.99.0` | `packages/workspace-ui/tests/unit/lead-turn-state.test.ts`              | `passed`      |
| REQ-135 | —      | `—`        | —                              | —                                                                       | `skipped`     |
| REQ-136 | —      | `—`        | —                              | —                                                                       | `skipped`     |
| REQ-150 | —      | `—`        | —                              | —                                                                       | `unavailable` |
| REQ-151 | —      | `—`        | —                              | —                                                                       | `unavailable` |
| REQ-153 | —      | `—`        | —                              | —                                                                       | `skipped`     |
| REQ-154 | —      | `—`        | —                              | —                                                                       | `skipped`     |
| REQ-155 | —      | `—`        | —                              | —                                                                       | `unavailable` |
| REQ-174 | source | `12a1830c` | `@adea-ai/db@0.99.0`           | `packages/db/tests/unit/migration-snapshot-comparator.test.ts`          | `passed`      |
| REQ-175 | —      | `—`        | —                              | —                                                                       | `skipped`     |
| REQ-176 | —      | `—`        | —                              | —                                                                       | `skipped`     |
| REQ-177 | —      | `—`        | —                              | —                                                                       | `skipped`     |

### The 36 rows the manifest maps no evidence for

Each row below is inventoried individually: the readiness criterion that names
it, the manifest's own gap text, the subject word the runner searched for, and
the lead it found. A lead is a file that mentions the subject; the score is how
many of the gap's words it also mentions.

| Id      | Disposition   | Readiness criteria that name it                                       | The gap (manifest text)                                                                                               | Subject searched             | Lead found                                                                                          |
| ------- | ------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------- |
| REQ-012 | `untestable`  | —                                                                     | no alternate lead backend is offered in product; only the candidate adapter is tested                                 | alternate, responsiveness    | `apps/web/e2e/chat-view.spec.ts` (4); no test file mentions _responsiveness_                        |
| REQ-033 | `skipped`     | —                                                                     | no test asserts use of the shared @adea-ai/ui components rather than local controls                                   | controls, evidenced          | `apps/web/e2e/conventional-workspace.spec.ts` (5); `apps/web/start/ui-tailwind-sources.test.ts` (5) |
| REQ-120 | `skipped`     | —                                                                     | no profile capability matrix exists in merged source; no test asserts per-profile evidence                            | matrix                       | `apps/desktop/tests/dev-runtime-connections-launch.test.ts` (4)                                     |
| REQ-133 | `skipped`     | —                                                                     | provider failure preserving draft, transcript and job receipts is not tested end to end                               | preserving, billing          | `apps/desktop/tests/dev-runtime-checkpoints.test.ts` (4)                                            |
| REQ-135 | `skipped`     | ACC-02 (e2e), ACC-07 (not-measured)                                   | keyboard traversal, focus return and status announcements are not asserted by any unit or E2E test in this repository | announcements, audit         | `apps/web/e2e/dev-view-a11y-certification.spec.ts` (6)                                              |
| REQ-136 | `skipped`     | ACC-01 (axe), ACC-03 (presence), ACC-04 (not-measured), ACC-05 (unit) | contrast, zoom, reduced motion and color-only status are not asserted by a test                                       | contrast, executed           | `apps/web/e2e/conventional-workspace.spec.ts` (5)                                                   |
| REQ-150 | `unavailable` | COST-03 (presence), COST-08 (not-claimed)                             | no budget reservation, child allocation or per-request enforcement exists in merged source or tests                   | enforcement                  | `apps/web/test/control-plane-child-joined/child-allocation.test.mjs` (6)                            |
| REQ-151 | `unavailable` | COST-04 (presence), COST-06 (unavailable)                             | estimate, reserved, reported, reconciled and settled cost states are not represented by a tested source               | represented                  | `apps/web/e2e/chat-view.spec.ts` (5)                                                                |
| REQ-153 | `skipped`     | OPS-02 (presence)                                                     | the source measures Dev resource metrics, not admission latency, approval age or duplicate suppression                | suppression, instrumentation | `apps/desktop/tests/dev-runtime-composition.test.ts` (5)                                            |
| REQ-154 | `skipped`     | OPS-03 (presence)                                                     | no lead admission stop by backend or profile is tested                                                                | backend, auditable           | `apps/desktop/tests/dev-runtime-browser-engine.test.ts` (3)                                         |
| REQ-155 | `unavailable` | COST-05 (unavailable), COST-07 (presence)                             | active-object time, storage writes and service consumption are not measured by any source or test                     | consumption                  | `apps/desktop/tests/dev-runtime-vault.test.ts` (6)                                                  |
| REQ-175 | `skipped`     | OPS-05 (presence)                                                     | no routing-back test to the previous supported path                                                                   | routing, compatible          | `scripts/fresh-postgres-acceptance/policy.test.mjs` (3)                                             |
| REQ-176 | `skipped`     | OPS-06 (not-measured)                                                 | the cleanup fence is for deletion, not lead attempt ownership                                                         | ownership, fenced            | `apps/desktop/tests/dev-runtime-resources.test.ts` (4)                                              |
| REQ-177 | `skipped`     | —                                                                     | no destructive cleanup gate or restoration-limit test exists in merged source                                         | restoration                  | `apps/desktop/tests/dev-runtime-resources.test.ts` (5)                                              |
| A02     | `skipped`     | —                                                                     | retried topic creation returning the original id is not tested                                                        | topic                        | `packages/db/tests/integration/lead-turn-historical.test.ts` (4)                                    |
| A03     | `skipped`     | —                                                                     | separate private and group runtime contexts are not tested                                                            | contexts, leakage            | `apps/web/e2e/conventional-workspace.spec.ts` (4)                                                   |
| A05     | `skipped`     | COST-01 (unit)                                                        | same-name Agents from different workspaces are not tested                                                             | different                    | `apps/web/e2e/conventional-workspace.spec.ts` (3)                                                   |
| A06     | `unavailable` | —                                                                     | invitation without enlistment authority is not tested; the group test covers grant revocation metadata only           | invitation                   | `packages/db/tests/integration/group-channels.test.ts` (6)                                          |
| A08     | `unavailable` | —                                                                     | bounded explicit dispatch with no broadcast feedback loop is not tested                                               | broadcast                    | `apps/desktop/tests/dev-runtime-composition.test.ts` (3)                                            |
| A10     | `skipped`     | COST-01 (unit)                                                        | Home protection and blank-workspace no-charge setup are not tested                                                    | charge                       | `apps/web/e2e/home-readiness-real.spec.ts` (3)                                                      |
| A12     | `skipped`     | COST-01 (unit)                                                        | a direct session inspected from Dev and Chat as one canonical session is not tested                                   | inspected                    | `apps/desktop/tests/managed-clone.test.ts` (4)                                                      |
| A13     | `skipped`     | —                                                                     | attach, review, hand-off and return with controller audit are not tested                                              | controller                   | `apps/web/e2e/chat-canvas.spec.ts` (4)                                                              |
| A14     | `skipped`     | —                                                                     | writer lease and conflict handling are not tested                                                                     | handling, scenario           | `apps/desktop/tests/dev-runtime-follow-ups.test.ts` (3)                                             |
| A15     | `untestable`  | —                                                                     | admitting two children while receiving human input is not tested                                                      | receiving                    | no test file mentions _receiving_                                                                   |
| A17     | `skipped`     | —                                                                     | aborting the lead with a queued child completion is not tested                                                        | aborting                     | `apps/desktop/tests/dev-runtime-follow-ups.test.ts` (3)                                             |
| A19     | `skipped`     | —                                                                     | approval pending across restart, expiry or changed input is not tested for lead work                                  | expiry                       | `apps/desktop/tests/dev-runtime-interactions.test.ts` (6)                                           |
| A21     | `untestable`  | —                                                                     | truthful degraded display for an adapter lacking resume, usage or confirmed cancel is not tested                      | lacking                      | no test file mentions _lacking_                                                                     |
| A22     | `skipped`     | —                                                                     | subscription quota exhaustion and auth-mode change are not tested                                                     | exhaustion                   | `apps/web/test/fixtures/source-contracts/source/model-connections.ts.snapshot` (3)                  |
| A25     | `skipped`     | ACC-01 (axe), ACC-02 (e2e), ACC-07 (not-measured)                     | screen reader, keyboard, zoom and reduced-motion checks are not asserted by a test                                    | reduced                      | `apps/web/e2e/chat-canvas.spec.ts` (5)                                                              |
| A26     | `skipped`     | —                                                                     | no budget reservation, child allocation or per-request enforcement exists in merged source or tests                   | enforcement, compaction      | `apps/web/test/control-plane-child-joined/child-allocation.test.mjs` (6)                            |
| A28     | `skipped`     | —                                                                     | no typed JSON artifact workflow runtime was located in packages or apps at the pinned SHA                             | located                      | `apps/web/test/control-plane-child-joined/host.mjs` (6)                                             |
| A31     | `skipped`     | OPS-06 (not-measured)                                                 | rollback with active new and old work and uncertain effects is not tested                                             | uncertain                    | `apps/web/test/control-plane-joined/lead-fence-v2.test.ts` (4)                                      |
| A32     | `untestable`  | —                                                                     | no LangGraph references were found in packages or apps at the pinned SHA; removal of Cloud services is not evidenced  | langgraph, readability       | no test file mentions _langgraph_ or _readability_                                                  |
| A33     | `skipped`     | —                                                                     | lead-tool management of configuration, memory, projects, worktrees and sessions is not tested                         | management, sharing          | `apps/desktop/tests/dev-runtime-composition.test.ts` (4)                                            |
| A36     | `unavailable` | OPS-09 (presence)                                                     | native cross-device history sync absence and supported-state reconnect are not tested                                 | absence                      | `apps/web/e2e/conventional-workspace.spec.ts` (7)                                                   |
| A37     | `untestable`  | —                                                                     | post-hoc events as insufficient evidence are not tested                                                               | effects, insufficient        | no test file mentions _insufficient_                                                                |

The `untestable` rows are the strong findings: the row's subject word appears in
**no test file in the repository at the candidate**. A15 (_receiving_), A21
(_lacking_), A32 (_langgraph_, _readability_), A37 (_insufficient_) and REQ-012
(_responsiveness_) have no trace of their subject anywhere. These are genuine
feature gaps that need a new test or a decision, not a re-run.

The `skipped` rows have a lead, but the lead is a file this runner does not run:
a Playwright specification, a fixture or helper module, or a script-lane test.
The runner names the lead rather than running it with the wrong runner, because
running a Playwright specification with `bun test` reports a lane mismatch as a
behaviour failure.

The `unavailable` rows are the ones whose readiness criterion is itself
`unavailable` or `not-claimed` (REQ-150, REQ-151, REQ-155) or whose subject
appears only in a file that is not part of this repository's product surface
(A06, A08, A36).

## The readiness criteria, measured at the candidate

The #1224 readiness inventory defines twelve presence probes over product
source. The runner executes them **at the frozen candidate**, with the
semantics the merged readiness script uses. A presence probe is a search, not a
proof: it shows that an identifier is or is not in product source at that
commit.

| Criterion | Probe                | Result at `12a1830c` | Files | Owner  |
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
| OPS-10    | rollout-runbooks     | **present**          | 2     | —      |

This is the source-of-truth result for the operations and cost criteria: at the
candidate, **there is no budget-reservation, operator-control, feature-flag,
metric-identifier, retention-gate or LangGraph reference in product source**.
The seven absences are the concrete, verifiable form of the cost and
operations gaps, and they are why REQ-150, REQ-151, REQ-153, REQ-154 and REQ-155
cannot be closed by a test run.

## Journeys

Three journeys are available without a release, and all of them are non-UI. The
`source` journey runs in a clean checkout of the candidate; the
`browser-condition` journey runs the browser-condition cited test; the
`disposable-integration` journey runs the database-backed cited tests against a
disposable loopback database. A fourth journey, `package-consumer`, packs the
packages the source journey built and installs them into a throwaway consumer.

The clean checkout is produced with `git archive`, and the runner verifies that
the exported tree is exactly the candidate's tree (3 246 files, no missing and
no extra path) before it runs anything in it. A test that value-imports a
workspace package needs that package's built artifact, so the packages the lane
needs are built from the same commit, with each package's own `build` script,
before any test runs. This is the same order the repository's own test task
uses (`test` after the package's own `build`).

### Journey 1: clean checkout (source class)

```
bun scripts/evidence-candidate-certification.mjs --run --json
```

| Step                      | Command                                                                                       | Exit             | Result                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------- |
| export the tree           | `git archive --format=tar 12a1830c4115eb46503a79aa0701452ac12ec695`                           | 0                | 3 246 files, matching the commit tree exactly                                    |
| install dependencies      | workspace packages linked into the checkout, third-party entries linked to the installed tree | 0                | 15 workspace trees linked                                                        |
| build the needed packages | `bun run build` (cwd `packages/types`, `packages/api-client`, `packages/state`)               | 0                | 3 209 ms, 2 300 ms, 1 281 ms                                                     |
| run the cited tests       | `bun test <file> --reporter=junit --reporter-outfile=<tmp>/junit/<file>.xml`                  | 0 for every file | 24 files, 369 testcases, 0 failures                                              |
| package-consumer          | `bun pm pack --destination <tmp>` then `bun add <tarball>`                                    | 0                | `@adea-ai/types` installed as `0.99.0` with every declared export target present |

The lane covered **24 of the 27** test files the manifest cites. The three it
leaves out are `apps/web/test/account-directory-pages.test.ts` (the
browser-condition file, run in journey 2), and the two database-backed
integration files (run in journey 3).

### Journey 2: browser condition

The browser-condition file is a unit test of page modules under the browser
export condition. It needs no browser process and no rendered surface, so it is
a test-only qualification and not the UI evidence itself. The **UI evidence
gate stays open** for the rows it touches.

```
bun scripts/evidence-candidate-certification.mjs --run --json
```

| Step                      | Command                                                                                                                 | Exit | Result                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---- | --------------------------------------------- |
| export the tree           | `git archive --format=tar 12a1830c4115eb46503a79aa0701452ac12ec695`                                                     | 0    | 3 246 files, matching the commit tree exactly |
| build the needed packages | `bun run build` (cwd `packages/types`, `packages/api-client`, `packages/state`, `packages/data`)                        | 0    | 1 830 ms, 603 ms, 546 ms, 2 986 ms            |
| run the cited test        | `bun test --conditions=browser apps/web/test/account-directory-pages.test.ts --reporter=junit --reporter-outfile=<tmp>` | 0    | 16 testcases, 0 failures                      |

This is the established repository command, from the cited receipt itself:
`bun test --conditions=browser apps/web/test/account-directory-pages.test.ts`.
It is run in the clean checkout of the candidate, with the candidate's own
built packages. **A04 and REQ-130 moved from `stale` to `passed` because of
it.** No UI source was edited and no UI implementation was taken over.

### Journey 3: disposable integration

The database is disposable and local. It was started under its own Compose
project and port, so it cannot touch another worker's instance, and it was
removed again afterwards.

```
ADEA_POSTGRES_PORT=55473 docker-compose -p f3w5-cert -f compose.yml up -d postgres
DATABASE_URL=postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:55473/agent_hq?sslmode=disable \
DATABASE_URL_UNPOOLED=postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:55473/agent_hq?sslmode=disable \
DATABASE_MIGRATION_URL=postgresql://agent_hq_local_migration:agent_hq_local_migration@127.0.0.1:55473/agent_hq?sslmode=disable \
  bun run --cwd packages/db db:migrate
# Migration verification passed (61 applied migration(s))

bun scripts/evidence-candidate-certification.mjs --run --json \
  --database-url "postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:55473/agent_hq?sslmode=disable" \
  --database-migration-url "postgresql://agent_hq_local_migration:agent_hq_local_migration@127.0.0.1:55473/agent_hq?sslmode=disable"
```

| Step                                                                   | Command                                                                                                | Exit | Result                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---- | ----------------------- |
| build `@adea-ai/types`                                                 | `bun run build` (cwd `packages/types`)                                                                 | 0    | 1 565 ms                |
| build `@adea-ai/auth`                                                  | `bun run build` (cwd `packages/auth`)                                                                  | 0    | 1 631 ms                |
| build `@adea-ai/remote-content`                                        | `bun run build` (cwd `packages/remote-content`)                                                        | 0    | 483 ms                  |
| build `@adea-ai/db`                                                    | `bun run build` (cwd `packages/db`)                                                                    | 0    | 30 504 ms               |
| run `packages/db/tests/integration/artifact-reference-service.test.ts` | `bun test --conditions=react-server --timeout 120000 <file> --reporter=junit --reporter-outfile=<tmp>` | 0    | 9 testcases, 0 failures |
| run `apps/web/test/integration/artifact-reference-routes.test.ts`      | `bun test --conditions=react-server --timeout 120000 <file> --reporter=junit --reporter-outfile=<tmp>` | 0    | 8 testcases, 0 failures |

The lane is 2 files, 17 testcases, 0 failures, exit 0.

The lane refuses any database URL that is not a loopback host, and the
repository's own test-target guard refuses a non-local target as well.

### Journey 4: the joined cross-product proof

This repository already commits a cross-repository pin:
`apps/web/test/control-plane-joined/control-plane-source.json` names the
control-plane revision the joined proof runs against. The runner reads that
committed pin; it never names a pair of its own.

The proof runs from the control-plane checkout, because the control-plane
sources compile under the control plane's own TypeScript configuration. The
checkout has to be at the pinned revision with no tracked changes, and the
proof checks that itself and refuses otherwise.

```
bun scripts/evidence-candidate-certification.mjs --run --json \
  --database-url "postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:55473/agent_hq?sslmode=disable" \
  --database-migration-url "postgresql://agent_hq_local_migration:agent_hq_local_migration@127.0.0.1:55473/agent_hq?sslmode=disable" \
  --control-plane-source <a control-plane checkout at 1aa42ff20c7fe1b0d9cc484983a7a631f4589746>
```

| Step                                         | Command                                                                                                                        | Exit | Result                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------------------- |
| check out the pinned control-plane revision  | `git clone --shared --no-checkout <control-plane> <tmp>` then `git checkout --detach 1aa42ff20c7fe1b0d9cc484983a7a631f4589746` | 0    | HEAD is the pinned revision, the tree is clean, and it contains the fence-v2 consumer `c97e91d40570d85076796709fc8304909afe4fcb` |
| install the control plane's own dependencies | `bun install --frozen-lockfile`                                                                                                | 0    | 302 packages, 16.04 s                                                                                                            |
| build the control plane's packages           | `bun run build` (turbo)                                                                                                        | 0    | 45 of 45 tasks successful, 33.2 s                                                                                                |
| run the joined proof                         | `bun test --conditions=react-server --timeout 120000 apps/web/test/control-plane-joined` (cwd the control-plane checkout)      | 0    | **41 tests, 0 failures, 2 274 assertions**                                                                                       |

The pair that was exercised is therefore a **verified** pair, and both of its
ends come from an existing authorized source:

| Side          | SHA                                        | Source of the SHA                                           |
| ------------- | ------------------------------------------ | ----------------------------------------------------------- |
| Adea          | `12a1830c4115eb46503a79aa0701452ac12ec695` | `refs/heads/main` of `adea-ai/adea`                         |
| Control plane | `1aa42ff20c7fe1b0d9cc484983a7a631f4589746` | this repository's own committed `control-plane-source.json` |

This is a source-level proof that the two repositories agree on the fence-v2
contract. It is **not** a candidate qualification and **not** production
qualification: the control-plane side is a pinned consumer-contract revision,
not a published candidate head, and the `cross-product` gate stays open for
that reason. The proof's own record says the same:
`docs/evidence/m18-01-3-joined-consumer-proof.md`.

One environment note: the `turbo` CLI appends a managed agent-guidance block to
`AGENTS.md` in the control-plane checkout when it detects an agent. The proof
refuses a checkout with tracked changes, so that block is restored before the
proof runs. It is a side effect in a temporary clone, not in any owner's
checkout.

**The proof needs a fresh disposable database.** It writes rows under fixed
identifiers, so a database that already holds them makes it fail. That is why
the repository's own lane provisions its own instance for it. The disposable
database is therefore recreated before the run:

```sh
docker-compose -p f3w5-cert -f compose.yml down -v
ADEA_POSTGRES_PORT=55473 docker-compose -p f3w5-cert -f compose.yml up -d postgres
DATABASE_URL=... DATABASE_MIGRATION_URL=... bun run --cwd packages/db db:migrate
```

A run against a database that already holds rows fails, and the runner reports
that failure with the reason rather than calling it a pass.

## The wider repository lane

The documented wider command is `bun test scripts/`.

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

| Gate                      | Owner                | The exact missing artifact                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `native-candidate`        | candidate owners     | An exact head for #1181, #1182, #1177 or #1180, and a native artifact built from it. No such head is pinned in this checkout, and the remote's open drafts (#1515, #1518, #1522, #1525) are drafts, not candidates.                                                                                                                                                                                      |
| `control-plane-candidate` | control-plane owners | A control-plane candidate head for CP #943. The control-plane remote publishes **no** `refs/pull/943/head` and no `refs/pull/943/merge`, so there is no head to name. The published control-plane candidate head is `95021f73a1127d117317ed78e5d7466f3ad61783` for CP #1210.                                                                                                                             |
| `packaged-native`         | release owners       | A packaged or native candidate artifact for the milestone, and the contract version the evidence manifest accepts. `compatibility.contractVersions` is empty, so **every** candidate contract is currently incompatible. This task does not authorize a release.                                                                                                                                         |
| `deployed`                | release owners       | A deployed environment built from the candidate. None is available, and this task does not authorize access to production.                                                                                                                                                                                                                                                                               |
| `cross-product`           | both product owners  | One exact pair of **candidate** heads, one from each repository. The joined journey **was** executed and passed at a verified pair (Adea `12a1830c…` with control-plane `1aa42ff2…`, 41 tests, 0 failures), but the control-plane side of that pair is a pinned consumer-contract revision, not a published candidate head: CP #943 has no pull request, so there is no control-plane candidate to name. |
| `soak-24h`                | release owners       | A 24-hour soak result. Not run here; this task does not authorize long paid or production soaks.                                                                                                                                                                                                                                                                                                         |
| `performance-cost`        | release owners       | Approved latency and cost thresholds and a meter. The candidate measures none of the eight instrumentation identifiers, so nothing can be measured for them.                                                                                                                                                                                                                                             |
| `owner-acceptance`        | owner                | The owner's daily-driver journey. A human decision, reported as open and never inferred.                                                                                                                                                                                                                                                                                                                 |
| `ui-evidence`             | Claude               | The axe audit, the keyboard suite and the screen-reader pass at the candidate, and the reduced-motion, contrast and zoom assertions. The browser-condition unit test is not this evidence.                                                                                                                                                                                                               |

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

# the map plus the clean-checkout, browser-condition and disposable-integration journeys
bun scripts/evidence-candidate-certification.mjs --run --json

# the disposable-integration journey against a disposable loopback database
bun scripts/evidence-candidate-certification.mjs --run \
  --database-url "postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:55473/agent_hq?sslmode=disable" \
  --database-migration-url "postgresql://agent_hq_local_migration:agent_hq_local_migration@127.0.0.1:55473/agent_hq?sslmode=disable"

# the joined cross-product journey, against a control-plane checkout at the
# revision this repository already pins
bun scripts/evidence-candidate-certification.mjs --run \
  --database-url "postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:55473/agent_hq?sslmode=disable" \
  --database-migration-url "postgresql://agent_hq_local_migration:agent_hq_local_migration@127.0.0.1:55473/agent_hq?sslmode=disable" \
  --control-plane-source <a control-plane checkout at 1aa42ff20c7fe1b0d9cc484983a7a631f4589746>

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
branch `codex/f3w5-adea-20261021` at `12a1830c4115eb46503a79aa0701452ac12ec695`.
The branch carries no tracked modification; the three owned files are the only
changes.

No pull request has been opened, no draft has been published, and no
credential has been created. Publishing is requested from root through the
authorized Sol Main local-gh publication handoff, and only after a complete
exact-head and test manifest exists. The exact-head and test manifest is the
`entries[]` array of the JSON report: every one of the 64 ids carries a commit,
a package version, a test path, a test title count, an evidence class and a
disposition.
