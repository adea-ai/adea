# Legacy SDK fixture (negative control)

The exact registry versions that predate the lead `childAllowance` disclosure of Control Plane
#1136 (first published in `@adea-ai/sdk` 1.20.0 and `@adea-ai/runtime-sdk` 1.17.0):

| Package                | Version |
| ---------------------- | ------- |
| `@adea-ai/sdk`         | 1.19.1  |
| `@adea-ai/runtime-sdk` | 1.16.1  |
| `@adea-ai/contracts`   | 1.21.4  |

They are installed here with this directory's own `package.json` and `bun.lock`, outside Adea's
dependency graph. Adea's `package.json`, lockfile and `node_modules` are not involved.
`tsconfig.override.json` is passed to `bun test --tsconfig-override` and maps the bare specifier
`@adea-ai/sdk` to this install for the boundary suite's test process only, so the product's own SDK
port, the suite's schema probe and the SDK's own `runtime-sdk` import all resolve to the legacy
graph. The suite then asserts through the product's port that the legacy install is the one in
effect. Bun prints an `Internal error: directory mismatch ... tsconfig.override.json` notice for
this flag; it is a Bun diagnostic and the override still applies (the assertions above would fail
otherwise).

Run with `bun run test:integration:control-plane-child-allowance-legacy-sdk` (see the
"Child allowance boundary" section of the parent README). Do not bump these pins: the fixture is
only useful while it is an SDK that lacks the field.
