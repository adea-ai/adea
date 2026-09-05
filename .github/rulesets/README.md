# Staged branch rulesets

GitHub does not allow repository rulesets (or legacy branch protection) on
private repositories in a free organization, so the definitions in this
directory cannot be applied yet. They are version-controlled here so the
intended policy is explicit and can be activated unchanged once the
organization has GitHub Pro/Team or the repository is made public.

## Intended policy (`code-foundry-main.json`)

Direct-workflow standard, identical in shape to the live `code-foundry-main`
rulesets on `cortana` and `plugins`:

- Targets `refs/heads/main`; enforcement `active`; **no bypass actors**
  (owners and codeowners included — everyone merges through PRs and CI).
- `pull_request`: squash or rebase merges only (merge commits blocked);
  stale reviews dismissed on push; review threads must resolve. The review
  _count_ stays `0` because owner-exempt review policy is enforced by the
  required `Review Policy / Gate` check instead (rulesets cannot express
  author-conditional counts, and bypass would also skip CI).
- `required_status_checks`: `Validation / Gate` and `Review Policy / Gate`
  (both GitHub Actions, `integration_id` 15368).

## Apply

Do NOT apply while `CI_BILLING_PAUSED=true`: the required `Validation / Gate`
check never reports while billing is paused, so an active ruleset would block
every merge to `main` with no way to satisfy it. Land changes through PRs with
local validation (`bun run format:check`, `lint`, `typecheck`, `test`, `build`)
plus `bun release --dry-run` for release readiness until billing resumes.

```bash
gh api -X POST repos/adea-ai/agent-hq/rulesets \
  --input .github/rulesets/code-foundry-main.json
```

Verify with:

```bash
gh api repos/adea-ai/agent-hq/rulesets \
  --jq '.[] | {id, name, enforcement}'
```
