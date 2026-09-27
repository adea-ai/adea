# Web app

The Adea TanStack Start application. It owns the unified workspace route, shell UI,
workspace switching, and composition of the shared runtime and package APIs.

Run it from the repository root with `portless` to use the stable
`https://adea.localhost` development URL. The direct fallback is
`PORT=3004 bun run dev`.

Production web output excludes the native workspace bootstrap and desktop-first-run
Chat. The desktop SPA build retains those components; both builds share the same
source and keep the runtime bridge check. Local Vite development retains the components for isolated transport fixtures;
full desktop bootstrap requires the canonical desktop build and cloud origin.
`bun run test:browser:desktop-client` builds that client and checks entry/retry
with a synthetic bridge on an isolated loopback server. It does not certify
native authority, a real PTY, or cloud bootstrap.
The Desktop shell CI lane runs the same artifact smoke on desktop changes;
its change selector includes the smoke script and guarded Dev View fixture paths. The check also rejects
test-terminal code in the packaged desktop module evidence.
`start:check-bundle` verifies the web output excludes those native-only modules.
