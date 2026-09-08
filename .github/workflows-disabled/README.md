# Temporarily disabled workflows

Repository-owned workflows and Dependabot configuration are parked here while Agent HQ is brought
to production readiness. GitHub Actions only loads workflow definitions from `.github/workflows`,
and Dependabot only loads `.github/dependabot.yml`, so these files are inactive but preserved for
later re-enablement. Code Foundry's generated callers remain active and sync-managed in
`.github/workflows`; obsolete disabled copies are not retained here.

When the app is ready, move the desired repository-owned workflow files back into
`.github/workflows`.

The preserved `performance.yml` workflow runs `bun run perf:gate`. That gate builds the web and
native shells, checks route and asset budgets, boots the browser scene, writes the bounded runtime
report to `.artifacts/scene-performance.json`, and rejects scene-load errors, canvas errors, slow
frames, or oversized transfers.
