# M11 request-bound encrypted return results

Recorded 2026-10-07 on the merged SDK, discovery and Agent profile foundations.
The package retains the existing envelope v1 and maintained `@hpke/core` 1.9.0
RFC 9180 suite. Existing command vectors and APIs remain unchanged. The generic
envelope implementation moves to `src/envelope.ts`; the public entry point
re-exports it alongside the new result helpers without a dependency change.

Each client receiver has a fresh request-scoped `return_<UUID>` public descriptor
and a nonextractable WebCrypto private key held in a module-private WeakMap.
Only the public descriptor serializes. Host sealing checks it against the
independently authorized workspace/node/request. Client opening binds direction,
key ID, scope and validity window, requires the existing branded atomic replay
guard, permits one in-flight operation and drops the key reference after success
or explicit disposal. Cancellation during a replay await clears plaintext and
refuses release. Standard envelope bounds and sanitized errors still apply.

| Validation                                                                      | Result                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mise exec -- bun run --cwd packages/remote-content test`                       | 22 passed, 82 assertions. Existing standards-library vectors and negative command cases pass, alongside wrong recipients/command keys, strict descriptor bounds, low-order X25519 refusal, scope/direction/window tampering, atomic replay, concurrency and cancellation cases.                                                                       |
| `mise exec -- bun run --cwd packages/remote-content typecheck`, `lint`, `build` | Passed.                                                                                                                                                                                                                                                                                                                                               |
| Headless `remote-result-crypto.spec.ts` via Playwright                          | Two cases passed: production browser module creates and retains the private return key; Node and Bun seal to its public descriptor; Chromium decrypts and refuses a second release. Synthetic secure-origin requests are intercepted in an isolated browser context; no app server or database is created. The spec is included in the main E2E lane. |
| `mise exec -- bun run test`                                                     | All workspace tasks and root coverage passed; root 296 tests, 7,020 assertions. The later descriptor-bound/low-order refinements passed the complete affected package suite above.                                                                                                                                                                    |
| `mise exec -- bun run lint`, `format:check`, `typecheck`                        | Passed; lint 17 tasks, type checks 30 tasks. Later affected source changes also passed package lint/type checks.                                                                                                                                                                                                                                      |
| `mise exec -- bun run build`                                                    | All 15 tasks passed using valid caches. A subsequent fresh web production build passed and verified 99 shared UI modules against 182 Tailwind sources.                                                                                                                                                                                                |
| `mise exec -- bun run test:security`                                            | 31 passed, 206 assertions.                                                                                                                                                                                                                                                                                                                            |
| `mise exec -- bun test scripts/docs-boundary.test.ts`                           | Four passed, 15 assertions.                                                                                                                                                                                                                                                                                                                           |
| `mise exec -- bun audit`                                                        | No vulnerabilities across 840 packages; no dependency or lockfile change.                                                                                                                                                                                                                                                                             |

## Remaining acceptance

This increment establishes return-result confidentiality and request binding,
not completion of #189 or M11. HPKE base mode does not authenticate a sender;
the production caller must validate the node's transport or signed receipt
before opening. The descriptor likewise belongs inside the authorized encrypted
command. Anyone who knows its public key can seal bytes, so successful decryption
alone must never be interpreted as host authorization or execution success.

Durable relay/inbox storage, authenticated node receipts, reconnect/restart
recovery, encrypted delivery into product flows, queued rotation/revocation and
live certification remain required. No result record is persisted, imported
into canonical history or promoted to R2 by this package. Cross-device key/device
synchronization remains separately owned by #193. No production resource,
deployment, migration or secret was changed. Final-head CI, packaged desktop and
live Control Plane acceptance are separate from the local interoperability cases.
