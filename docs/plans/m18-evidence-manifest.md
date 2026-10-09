# M18 evidence manifest (#1225)

`m18-evidence-manifest.json` maps the 24 requirement ids and A01–A40 named by
[#1225](https://github.com/adea-ai/adea/issues/1225) to exact evidence. The
validator is `scripts/evidence-manifest.mjs`. Run it with
`bun run evidence:manifest`. Options:

- `--strict`: require every id to be candidate-compatible.
- `--json`: print the full report.
- `--repo <key>=<path>`: map a repository key to a local checkout. The home key `adea`
  defaults to the worktree root.

The committed manifest declares one repository, `adea`, pinned to canonical `main`
`34e173df…`, and maps nothing. Every id is `pending`.

## Repositories and immutable identity

`repositories` maps a key to `{ name, rootCommit, sourceSha }`:

- `rootCommit` is the immutable identity: the root commit of the repository's history.
  A local checkout is accepted only if `sourceSha` exists in it and `rootCommit` is one
  of that commit's root commits. A checkout of a different repository, or a fork that
  lacks the root, is refused.
- `sourceSha` is the exact commit every reference to that repository must resolve at.
- A reference to a key with no `--repo` mapping is invalid, not pending.

## Entries and references

`entries[]` is `{ id, coverage, gaps?, repoEvidence[], candidateEvidence[] }`.
`coverage` is required: `complete` or `partial`. A `partial` entry must list `gaps` and cannot carry
candidate evidence; its references are still checked, but its status stays `pending`.
Current mappings are all `partial`: the cited tests exercise part of each criterion. `id` must be a known
requirement or A-id. Every `repoEvidence` item must name a declared `repository`.

- `{ kind: "test-reference", repository, path, name }` checks that a test title appears in a
  `*.test.*` file at `sourceSha`. The check is a source-text match, so comments and strings
  also match. It is weaker than a runner receipt.
- `{ kind: "execution-reference", repository, path, sha256, receipt: { path, sha256 } }` points to
  a run record `{ repository, sourceSha, executedAtHead, file, command, exitCode, status, summary, ids[] }`
  (a recorded claim) and to a JUnit receipt written by the runner. Both bytes must match their
  hashes. The receipt counts must equal `summary`, and `executedAtHead` must be a commit in the
  checkout. A `test-reference` counts as runner-verified only when its title is a passing testcase
  in the receipt for the same file.
- Entries may also list `sourceReferences: [{ repository, path }]`: merged source files that must
  exist at `sourceSha`. A source reference is context, not evidence.
- `{ kind: "candidate-reference", path, sha256 }` points to a JSON record
  `{ candidateId, channel: "packaged" | "deployed", contractVersion, status: "passed", ids[], sources }`.
  `sources` must equal `sourceSha` for every repository the id references, and
  `contractVersion` must be listed in `compatibility.contractVersions`.

Paths are repo-relative POSIX paths with no `..`, absolute prefix, or empty segment.

## File safety

- Git blobs must be regular (`100644`/`100755`). Symlinks, submodules, and trees are
  refused, and so are blobs over 1 MiB.
- Working-tree records must resolve, after symlinks, inside the home root. Outside
  symlinks, directories, and files over 1 MiB are refused before they are read.

## Statuses

| Status                 | Meaning                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `pending`              | No mapping, or an entry with no repository evidence.                                         |
| `invalid`              | A reference is missing, unmapped, mismatched, unsafe, non-regular, oversized, or not passed. |
| `repo-declared`        | Test title declared at `sourceSha`; no execution reference recorded.                         |
| `repo-verified`        | At least one execution reference resolves at `sourceSha`; no candidate evidence yet.         |
| `candidate-compatible` | Repository evidence resolves and at least one compatible candidate record exists.            |

Default mode fails only on `invalid` and schema errors. `--strict` also fails on any
id that is not `candidate-compatible`.

## Limits

- The run record is a claim and the receipt is the runner output. Both are committed by us, so
  neither is independent verification. Re-running the command at `executedAtHead` is the check.

- The validator checks declarations, hashes, and recorded `passed` status. It does not
  rerun tests or prove a candidate binary was built from the declared SHAs.
- `candidate-compatible` is a manifest-level check, not a certification decision.
- Local checkouts are supplied by the caller and are trusted to be honest copies of the
  named repository; the root-commit check catches a wrong repository, not a forged history.
- A shallow checkout (for example, CI's default depth) may lack the pinned commit or
  root; validation then fails closed.
- The #1225 PRD and TDD (Google Docs) define the requirement and A-id text. They are not
  in this repository, so the manifest carries ids only.
