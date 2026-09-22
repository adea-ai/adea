# M10 #33 packaged native runtime evidence — 2026-09-22

## Result

The stable Electrobun payload was built from source commit
`aa47a7a7c2f0a7dba9253925b148d820da5d0deb` and its bundled Bun 1.4.0
executable ran the native capability probe successfully. The parent generates
the synthetic Keychain service ID and passes it to the bundled child; the
child deletes the item in a `finally` cleanup path, and the parent runs a
bounded bundled-Bun cleanup attempt for the same service ID after every child
exit, including timeout. The probe never prints the secret, service ID, or a
digest of the secret. Its SQLite database is disposable and is removed after
the probe.

The evidence-only commits in this branch do not modify the desktop bundle
inputs, so the recorded application source commit remains the bundle source
commit even though the reproducibility script and this report are layered on
top of it.

The redacted machine result is retained at
`artifacts/packaged/m10-33-native-evidence.json` (ignored generated output).

## Bundle identity

| Item                           | Value                                                              |
| ------------------------------ | ------------------------------------------------------------------ |
| Channel                        | stable payload                                                     |
| Bun runtime                    | 1.4.0                                                              |
| Payload archive SHA-256        | `f6a8979c443b2b7713e8462a880154089b81df9e43e571b0950a6c0aca8157a2` |
| Bundled Bun executable SHA-256 | `539598c775882420b9d8deb7dc14d845f20f7d26f5600c50ab067dde6ac3f3bf` |
| `version.json` SHA-256         | `41499997bc791d0235b40ed2c47e83787dc6db5e76e2c3dbbca2cb26d42bf960` |

## Reproduction

The package was prepared and probed with:

```sh
bun install --frozen-lockfile
bun run --cwd apps/desktop shell:build
bunx --bun electrobun build --env=stable
bun scripts/test-m10-33-packaged-native.mjs \
  --app-bundle apps/desktop/shell/build/stable-macos-arm64/Adea.app \
  --artifact artifacts/packaged/m10-33-native-evidence.json \
  --source-commit aa47a7a7c2f0a7dba9253925b148d820da5d0deb
bun scripts/test-m10-33-packaged-native.mjs --self-test
```

The final command passed with:

- `Bun.secrets`: available; synthetic set/get round trip passed; deletion and
  subsequent absence check passed.
- `bun:sqlite`: available; WAL database opened; an injected unique-constraint
  failure rolled back the preceding insert; reopening retained only the
  committed row.
- The script bounds payload extraction at 120 seconds, the bundled probe at 30
  seconds, and the parent cleanup attempt at 10 seconds. Temporary extraction
  and database directories are removed on every exit path. The self-test checks
  that a false secret round-trip, deletion, SQLite rollback, or SQLite reopen
  boolean fails the probe before a PASS artifact is emitted.

Additional checks:

```sh
bun scripts/test-m10-33-packaged-native.mjs --self-test
bunx oxfmt --check scripts/test-m10-33-packaged-native.mjs \
  docs/evidence/m10-33-packaged-native-2026-09-22.md
bunx oxlint scripts/test-m10-33-packaged-native.mjs
bun test scripts/docs-boundary.test.ts \
  apps/desktop/tests/dev-runtime-vault.test.ts \
  apps/desktop/tests/dev-runtime-vault-keychain.test.ts \
  apps/desktop/tests/host-store.test.ts
npx code-foundry doctor
git diff --check
```

The self-test passed. Formatting, lint, and docs boundary checks passed; the
combined test command passed 26/26 (143 expect calls), the repository doctor
passed, and the diff check passed.

## Application gap

This evidence proves the bundled runtime capability, not adoption by the
application's M10 authority. The current implementation still:

- invokes `/usr/bin/security` from
  `apps/desktop/shell/src/dev-runtime/vault.ts` for its production key store;
- persists credential metadata through `createDurableJsonStore` in
  `credentials.json`; and
- uses the JSON `host-store` for the Dev Runtime durable authorities rather
  than `bun:sqlite`.

No application-level Bun.secrets adapter, SQLite schema, migration, recovery
compatibility path, or packaged vault round-trip test exists in this source
commit. Issue #33 therefore remains open for the reviewed implementation and
migration work.
