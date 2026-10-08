# Pi Durable candidate consumer proof

These test-only consumers install hash-verified local public SDK/contracts tarballs in a temporary directory. They do not change repository dependency pins, publish packages, configure credentials, or activate a production runtime.

`run-candidate-proof.mjs` requires an isolated loopback PostgreSQL fixture and explicit model/lead artifact manifests and host modules. The default mode preserves workspace-only rejection and an independent CP project control; that control never creates an Adea project mapping.

Use `--workspace-positive true --workspace-prepare-funding true` with a repaired, immutable host supporting `workspaceScope` and `prepareFunding` to exercise the prepared workspace journey. It uses a real Adea message/intent and recorded sender, the actual packed SDK and exported response schemas, and the product SDK adapter. Preparation must leave runtime/dispatch/provider counters unchanged; lookup must leave all counters unchanged. Dispatch receives only the canonical intent and preparation reference. Replay retains the execution, attempt and actual session identity.

`--workspace-cancel-in-flight true` adds a separate canonical turn and held scripted provider response. Its cancellation evidence must retain uncertain accounting holds; it does not certify a settled provider charge or natural approval handling.

Use `--lead-host-process true` when the producer runs inside the Adea compiler context. It launches the exact CP fixture entry in a separate Bun process with CP's unchanged compiler configuration and verifies its immutable head and empty worktree digest. Metrics and registration use the existing authenticated fixture HTTP controls; completion is polled through the actual SDK. The process fixture does not expose the in-process drain or awaiting-input helpers, so this mode explicitly rejects the optional in-flight cancellation scenario and does not claim project-control cancellation. Do not use Bun's unqualified tsconfig override flag: its directory-mismatch/decorator-loader errors were retained separately from execution evidence.

Compiler and response-binding fixture tests do not establish connected PostgreSQL, timeline publication, device authority or live provider acceptance. A report is emitted only after the requested connected assertions complete. Retain old negative evidence separately, and record the actual host source identity: a dirty host must never be described as the immutable tarball head.
