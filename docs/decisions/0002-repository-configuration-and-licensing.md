# Agent HQ Repository Configuration and Licensing Baseline

Status: Superseded by the oxlint/oxfmt migration (code-foundry 1.3.1) — the
formatter decision below applied to Prettier and is retained for history.
Date: 2026-08-21

## Decision

Agent HQ uses the Code Foundry-managed `.prettierrc` as its single Prettier
configuration. The older duplicate `.prettierrc.json` and the superseded root
shadcn configuration are removed. shadcn configuration was scoped to the
consumers that owned it (`apps/web/components.json` and
`packages/ui/components.json`); the M6 Solid migration retired the shadcn CLI
and both files with the React component workflow
([0007](./0007-solid-tanstack-start.md)). The neutral Tailwind base layer the
components relied on is vendored as `packages/ui/src/styles/base.css`.

The repository is licensed under Apache License 2.0. The root package metadata
uses the SPDX identifier `Apache-2.0`, Code Foundry is configured with
`apache-2.0`, and `LICENSE` and `NOTICE` carry matching Apache-2.0 notices.

The repository is private, so CodeQL, Dependency Review, and Dependabot remain
explicitly disabled unless the corresponding GitHub support and repository
maintenance policy are intentionally provisioned later.

Bun remains the repository package manager and test runner. Repository guidance
uses the actual Bun scripts (`bun run format:check`, `bun run lint`,
`bun run typecheck`, and `bun run test`). The shared UI kit is Kobalte-backed,
not Radix or Base UI ([0007](./0007-solid-tanstack-start.md)). Home and Work are selected through the unified root
route with `?scene=home` and `?scene=work`; legacy `/scenes/*` links are not
supported.

Code Foundry's standard validation and release callers are active under
`.github/workflows/`. The draft-PR caller remains disabled because this private
repository has no configured automation token or Actions permission to create
pull requests. The older files under `.github/workflows-disabled/` remain as
inactive reference copies. Desktop release packaging is owned by the
repository-specific `release-assets.yml` extension. GLB model assets are
explicitly treated as binary by Git attributes.

## Alternatives considered

- Keeping both equivalent Prettier files, which creates unnecessary config
  ambiguity and allows future changes to drift.
- Keeping the root shadcn file alongside the app and package configs, even
  though it describes the superseded app layout. (Both scoped files are now
  gone too: the shadcn CLI is React-only tooling.)
- Retaining GPL/AGPL licensing metadata from the initial Code Foundry
  baseline.
- Continuing to document npm, Vitest, or the removed scene routes.
- Re-enabling workflows before the production-readiness gate was complete.

## Rationale

One formatter source avoids resolution ambiguity and follows the configuration
that Code Foundry will maintain. Scoped shadcn files matched the monorepo package
boundaries while React owned the component workflow; the Solid kit keeps the
same class/data-slot contract without the CLI.
Apache-2.0 is the requested permissive project license and must be consistent
across machine-readable metadata and human-readable notices. The root route,
Bun commands, and active Code Foundry policy reflect the current application
shape rather than the repository's superseded initializer state.

## Consequences

- Future Code Foundry syncs should retain the single `.prettierrc` baseline.
- New model formats should be added to `.gitattributes` when they are not
  safely recognized as text or binary automatically.
- Standard Code Foundry validation and release automation are active; feature
  pull requests are opened manually until private-repository PR automation is
  provisioned. Mobile store release remains a separate follow-up because
  signing and provisioning credentials are not part of this repository.
