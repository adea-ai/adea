# M18 evidence manifest (#1225)

`m18-evidence-manifest.json` maps the 24 requirement ids and A01–A40 named by
[#1225](https://github.com/adea-ai/adea/issues/1225) to evidence. The validator is
`scripts/evidence-manifest.mjs`; run it with `bun run evidence:manifest`.

- `--strict`: exit non-zero unless every id is candidate-compatible.
- `--json`: print the full report.
- `--repo <key>=<path>`: map a repository key to a local checkout. The home key `adea`
  defaults to the worktree root.

The default run prints the revision it checked, the counts, every invalid id, the
pending ids, and an explicit `certification:` line. Exit 0 means the manifest is
internally valid; it does not mean the criteria are certified.

## Current state

The committed manifest pins `adea` to `9fb30c49…` (canonical `main` when this was
reconciled) and maps every id. Every mapped id is `partial`: the cited tests cover part
of the criterion, and the gaps are listed on the entry. Nothing is certified:
`certification: incomplete (0 of 64 candidate-compatible)`.

## Repositories and identity

`repositories` maps a key to `{ name, rootCommit, sourceSha }`:

- `rootCommit` is the immutable identity. A local checkout is accepted only if
  `sourceSha` is a commit in it and `rootCommit` is one of that commit's root commits.
- `sourceSha` is the single revision every reference to that repository must resolve at.

## Entries

`entries[]` is `{ id, coverage, gaps?, criteria?, repoEvidence[], candidateEvidence[], sourceReferences? }`.

- `coverage` is required. `partial` must list `gaps` and cannot carry candidates; its
  status is always `pending`. `complete` must list `criteria` and no `gaps`.
- `criteria` is `[{ text, tests: [{ repository, path, name }] }]`. A criterion is evidenced only if
  every listed test is a runner-verified `test-reference` with the same repository, path, and title.
  Repository identity is part of every match: the same path and title in another repository never
  matches.
- `sourceReferences` (`[{ repository, path }]`) are merged source files that must exist at
  `sourceSha`. They are context, not evidence.

### References

- `{ kind: "test-reference", repository, path, name }`: the title appears in a `*.test.*`
  file at `sourceSha`. This is a source-text match, so comments and strings also match. It
  becomes runner-verified only through an execution-reference whose receipt lists it as
  passing.
- `{ kind: "execution-reference", repository, path, sha256, receipt: { path, sha256 } }`: a
  run record `{ repository, sourceSha, executedAtHead, file, command, exitCode, status,
summary, ids[] }` (a claim) and a JUnit receipt written by the runner (the output). Both
  must match their hashes. Exact revision: `sourceSha` and `executedAtHead` must equal the
  pinned SHA. `status` must be `passed` and `exitCode` 0. The receipt's per-testcase counts
  must equal `summary`. Receipts are scoped to the reference's repository and file: a title counts
  only if it passes in every execution-reference for that repository and file.
- `{ kind: "candidate-reference", path, sha256, receipt: { path, sha256 } }`: a packaged or
  deployed record `{ candidateId, channel, contractVersion, status, exitCode, ids[], sources,
summary }`. `sources` must equal the pinned SHA for every repository the id references, including the
  repositories of its `sourceReferences`. The
  contract version must be listed in `compatibility.contractVersions`. Its own receipt must
  show every testcase passing.

Paths are repo-relative POSIX paths with no `..`, absolute prefix, or empty segment.

## Statuses

| Status                 | Meaning                                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `pending`              | No mapping, a partial entry, or an entry without repository evidence. Gaps are listed.                                           |
| `invalid`              | A reference is missing, unmapped, mismatched, unsafe, non-regular, oversized, or not passing, or a complete claim lacks support. |
| `repo-verified`        | A complete entry whose declared tests all passed at the pinned revision and whose criteria are evidenced.                        |
| `candidate-compatible` | A complete entry with a compatible, all-passing candidate.                                                                       |

## File safety

- Git blobs must be regular (`100644`/`100755`). Symlinks, submodules, and trees are refused,
  and blobs over 1 MiB are refused.
- Working-tree records must resolve, after symlinks, inside the home root. Outside symlinks,
  directories, and files over 1 MiB are refused before they are read.

## Limits

- The run record is a claim and the receipt is runner output. Both are committed by us, so
  neither is independent verification. Re-running the command at `executedAtHead` is the
  check.
- Receipts are bun's JUnit output with only the machine `hostname` attribute removed. The
  check scans committed artifacts for local paths.
- A `test-reference` proves the title is declared in source text and, with a receipt, that it
  passed. It does not prove the title covers the criterion; that judgement is in `criteria`
  and is human-authored.
- Local checkouts are trusted to be honest copies of the named repository. The root-commit
  check catches the wrong repository, not forged history.
- A shallow checkout (for example, CI's default depth) may lack the pinned commit or root;
  validation then fails closed. The real-git test is skipped when the pinned commit is absent,
  and the skip is reported as skipped, not passed.
- The #1225 PRD and TDD (Google Docs) define the requirement and A-id text. They are not in this
  repository, so the manifest carries ids and gaps only.
