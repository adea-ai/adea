# ADR 0005: Repository topology, naming, and visibility

- Status: Accepted
- Date: 2026-09-06

## Decision

The product splits into a public shell and a permanently private cozy sim,
positioned as "Slack plus Sims for AI agents":

| Repository              | Visibility                | Positioning                                                 |
| ----------------------- | ------------------------- | ----------------------------------------------------------- |
| `adea-ai/adea`          | Private now, public later | The Slack: chat control-plane for harnesses and agents.     |
| `adea-ai/agent-sim`     | Private permanently       | The Sims: cozy management sim where those agents live/work. |
| `adea-ai/assets`        | Private permanently       | Binary art pack feeding the sim (unchanged).                |
| `adea-ai/control-plane` | Public                    | Backend authority (scene-agnostic, unchanged).              |
| `adea-ai/plugins`       | Public                    | Plugin registry (unchanged).                                |

`adea-ai/agent-hq` renames to `adea-ai/adea`; "Agent HQ" retires as a codename.
Package scopes follow their repo: `@adea/*` in the shell, `@agent-sim/*` in
the engine, with the shell-to-sim contract in a protocol package. The shell
never bundles engine code or binary art: the virtual route loads the engine
remotely behind entitlement, and public build lanes stay packless (enforced by
`scripts/asset-pack-boundary.test.ts`).

## Alternatives considered

- `adea-spatial` / `adea-3d` / `adea-game` for the engine repo: accurate but
  either vague, narrow, or mispositioning next to a productivity product.
- Single public monorepo with the private asset pack only: rejected, the
  engine fork risk from ADR-0004's moat analysis stands.
- `adea-sim` over `agent-sim`: brand-consistent but loses the double meaning;
  "agent" here denotes the sim's residents (AI agents), not the retired
  codename, and pairs with the repo tagline below.

## Tagline

`agent-sim` ships with the repo description "a cozy management sim for your
AI agents" from day one so the name is never read cold.

## Consequences

- Engine extraction (renderer, scenes, room designer, sim authority, asset
  pipeline, perf budgets) targets `adea-ai/agent-sim` with history preserved;
  no engine code or `.glb` may appear in public `adea` build outputs.
- `adea` stays private until the Phase-1 hygiene list completes (secret
  scanning, push protection, CodeQL, channel split, token rotation); only
  then does it flip public. `agent-sim` and `assets` never flip.
- Follow-up: `@agent-hq/*` scope rename to `@adea/*` / `@agent-sim/*` lands
  with the extraction, when boundary imports are rewritten anyway.
