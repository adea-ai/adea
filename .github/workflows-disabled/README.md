# Temporarily disabled workflows

The repository workflows and Dependabot configuration are parked here while Agent HQ is brought
to production readiness. GitHub Actions only loads workflow definitions from `.github/workflows`,
and Dependabot only loads `.github/dependabot.yml`, so these files are inactive but preserved for
later re-enablement.

When the app is ready, move the desired workflow files back into `.github/workflows` and update
`.github/code-foundry.yml` to enable the corresponding Code Foundry features.
