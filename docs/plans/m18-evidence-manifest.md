# M18 evidence manifest (#1225)

`m18-evidence-manifest.json` maps the 24 requirement ids and A01–A40 named by
[#1225](https://github.com/adea-ai/adea/issues/1225) to exact evidence. The
validator is `scripts/evidence-manifest.mjs`; run it with
`bun run evidence:manifest` (add `--strict` to require every id to be
candidate-compatible, `--json` for the full report).

The committed manifest pins `sourceSha` to `34e173df7bf4654d53e2b4daed5ff41239cafd8b`
(canonical `main`) and maps nothing. Every id is therefore `pending`.

## Schema (v1)

- `issue` must be `1225`; `sourceSha` must be a 40-hex commit present in the repository.
- `compatibility.contractVersions`: candidate contract versions this manifest accepts.
  Empty means no candidate can qualify.
- `entries[]`: `{ id, sourceSha, repoEvidence[], candidateEvidence[] }`. `id` must be a
  known requirement or A-id. `sourceSha` must equal the manifest's.
- `repoEvidence` items:
  - `{ kind: "test", path, name }`: `path` must be a `*.test.*` file that declares `name`
    as a quoted test title at `sourceSha`. This shows the test exists, not that it passed.
  - `{ kind: "run", path, sha256 }`: a JSON record `{ sourceSha, command, status: "passed", ids[] }`
    whose bytes match `sha256`.
- `candidateEvidence` items: `{ kind: "candidate", path, sha256 }`, a JSON record
  `{ candidateId, channel: "packaged" | "deployed", sourceSha, contractVersion, status: "passed", ids[] }`.
  The record is compatible only if `sourceSha` equals the manifest's and `contractVersion`
  is listed in `compatibility.contractVersions`.

Paths are repo-relative POSIX paths with no `..`, absolute prefix, or empty segment.

## Statuses

| Status                 | Meaning                                                                           |
| ---------------------- | --------------------------------------------------------------------------------- |
| `pending`              | No mapping, or an entry with no repository evidence.                              |
| `invalid`              | Mapping exists but a reference is missing, mismatched, unsafe, or not passed.     |
| `repo-verified`        | Repository evidence resolves at the pinned SHA; no candidate evidence yet.        |
| `candidate-compatible` | Repository evidence resolves and at least one compatible candidate record exists. |

Default mode fails only on `invalid` (and schema errors). `--strict` also fails on any
non-`candidate-compatible` id.

## Limits

- The validator checks declarations, hashes, and recorded `passed` status. It does not
  rerun tests or verify that a candidate binary was built from `sourceSha`.
- `candidate-compatible` is a manifest-level check, not a certification decision.
- The #1225 PRD and TDD (Google Docs) define the requirement and A-id text. They are not
  in this repository, so the manifest carries ids only.
