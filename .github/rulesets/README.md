# Branch ruleset

`code-foundry-main.json` is the definition of the live `code-foundry-main`
ruleset on `adea-ai/adea` (the repository is public, so rulesets apply). It is
version-controlled here so the policy is explicit; change the ruleset and this
file together.

## Policy

- Targets `refs/heads/main`; enforcement `active`; **no bypass actors**
  (owners and codeowners included — everyone merges through PRs and CI).
- `pull_request`: squash merges only; stale reviews dismissed on push; review
  threads must resolve. The review _count_ stays `0`.
- `required_linear_history`, no deletion, no non-fast-forward pushes.
- `required_status_checks` (all GitHub Actions, `integration_id` 15368):
  - `Validation / Gate` — the Code Foundry aggregate (lint, type-check, build,
    unit, integration, E2E shards, security).
  - `Desktop shell` — the Electrobun shell lane.
  - `Visual gate` — the workspace pixel lane (`visual-lane.yml`).
  - `Host gate` — the TanStack Start host lane (`tanstack-start.yml`).

## Why the lanes end in a gate job

A required check must report on every pull request. A workflow-level `paths`
filter never reports on a pull request that touches none of the paths, so such a
check would block unrelated pull requests forever. `visual-lane.yml` and
`tanstack-start.yml` therefore trigger on every ready pull request, a `changes`
job runs `scripts/ci-lane-selection.mjs` to decide whether the lane applies and
which pixel suites the change affects, and a final `gate` job reports:

- pass when the change touches none of the lane's inputs, or the lane passed;
- fail when the lane failed, was cancelled, or change detection failed;
- nothing yet while the lane is still running, which keeps the merge blocked.

Draft pull requests run none of these (they cannot merge). Marking a pull
request ready starts the lanes.

## Apply

Updating the live ruleset needs repository admin:

```bash
gh api -X PUT repos/adea-ai/adea/rulesets/22403584 \
  --input .github/rulesets/code-foundry-main.json
```

Verify with:

```bash
gh api repos/adea-ai/adea/rulesets/22403584 \
  --jq '.rules[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context'
```

Add a new required check in a pull request that makes the check report on
every pull request first, then update the ruleset once that pull request is
merged. A required check that no workflow reports blocks every merge.
