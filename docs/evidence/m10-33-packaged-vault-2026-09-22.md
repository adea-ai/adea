# M10 #33 packaged application-level vault evidence — 2026-09-22

## Result

The stable Electrobun payload was built from source commit
`10589041b10f64e5528330c98e7dd9c46fbdbe33` (the bundle input commit includes
PR #577). The harness bundles the production
`apps/desktop/shell/src/dev-runtime/vault.ts` adapter and executes it with the
Bun 1.4.0 executable shipped inside that app payload.

The run passed all application-level checks:

- a synthetic legacy `/usr/bin/security` key migrated into Bun.secrets and was
  retained in the legacy slot;
- the sealed synthetic vault opened with the migrated store and with the
  legacy-only store used by a simulated downgrade;
- denied and locked Bun.secrets reads returned `auth_required` without a write;
- mismatched Bun and legacy keys returned `corrupt_state` before the vault
  opened.

The probe emits only booleans, typed error codes, and artifact hashes. Synthetic
key and credential material is never printed. The Keychain service names are
unique per run, and both the child probe and parent cleanup attempt remove the
legacy and Bun slots. The recorded run reports both cleanup paths succeeded.

## Bundle identity

| Item                           | Value                                                              |
| ------------------------------ | ------------------------------------------------------------------ |
| Channel                        | stable payload                                                     |
| Bun runtime                    | 1.4.0                                                              |
| Payload archive SHA-256        | `22090b2cd35902ec9eb639675812a78e0de48297981cbddfc6a7c36bd334cab6` |
| Bundled Bun executable SHA-256 | `539598c775882420b9d8deb7dc14d845f20f7d26f5600c50ab067dde6ac3f3bf` |
| Probe SHA-256                  | `c5f8f83ddd28dbf69183c5438c66beb3f4c42413df32f3762947f2f772689a10` |

## Reproduction

```sh
bun install --frozen-lockfile
bun run --cwd apps/desktop shell:build
bunx --bun electrobun build --env=stable
bun run test:packaged:vault \
  --app-bundle apps/desktop/shell/build/stable-macos-arm64/Adea.app \
  --artifact artifacts/packaged/m10-33-vault-evidence.json \
  --source-commit 10589041b10f64e5528330c98e7dd9c46fbdbe33
bun run test:packaged:vault --self-test
```

The generated JSON artifact is ignored and contains no secret material.

## Scope

This is packaged Bun executable evidence for the application adapter and vault
authority. It does not launch the CEF window or exercise an owner approval UI;
the harness issues a synthetic durable approval inside the same production vault
authority so the Keychain, Bun.secrets, migration, downgrade, and refusal
paths can be checked without an interactive native prompt.
