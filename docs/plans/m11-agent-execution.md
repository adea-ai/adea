# M11 — Agent Execution

Milestone: [Adea M11](https://github.com/adea-ai/adea/milestone/6).
Acceptance baseline: [every source checkbox](m11-acceptance.json), captured
2026-10-07. The issue titles still use their original M6 numbering. A closed
issue or checked source box is not current acceptance evidence: every criterion
starts unverified and needs evidence matching its scope.

## Scope and order

| Issue                                              | Required work                                                                                                                                          | Current evidence boundary                                                                                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#36](https://github.com/adea-ai/adea/issues/36)   | Pinned public SDK, separate service credentials, compatibility, correlation, Local and remote contracts, persistence-profile conformance               | Closed upstream with unchecked criteria. Published SDK adoption starts with the administration hop; execution and Local IPC must also be exercised.        |
| [#37](https://github.com/adea-ai/adea/issues/37)   | Location-aware runtime and host inventory, distinct node/connection health, freshness, transport identity, grants, capability and history availability | Inventory types now exist in Dev Runtime; reconcile older missing-inventory notes against current wiring and fixtures.                                     |
| [#38](https://github.com/adea-ai/adea/issues/38)   | Durable direct/relayed submission, intent ownership, idempotency, timeout reconciliation, restart, explicit offline state                              | Existing outbox schema is substrate, not delivery proof. Exercise the production submission path and its transaction boundaries.                           |
| [#39](https://github.com/adea-ai/adea/issues/39)   | Cloud-safe event inbox, scoped ordering/replay, lifecycle mapping, redaction, conversation projection                                                  | Prove actual ingestion and projection, including gaps and content-leak canaries.                                                                           |
| [#40](https://github.com/adea-ai/adea/issues/40)   | Cancel, resume, approval/denial and input across attempts, races, reconnect, authorization changes                                                     | Product mutations must reach the selected execution authority, not just change local Task status.                                                          |
| [#41](https://github.com/adea-ai/adea/issues/41)   | Profile/version authorization, audit, blocked/remediation states, immutable plan/Skill provenance, concurrent submission                               | Catalog metadata and an Agent's version columns alone do not prove execution binding.                                                                      |
| [#43](https://github.com/adea-ai/adea/issues/43)   | Local/Self-hosted external session list/reference/resume, capability and history boundaries                                                            | Native session state cannot replace Adea Message ownership.                                                                                                |
| [#86](https://github.com/adea-ai/adea/issues/86)   | Dedicated R2 scope, promotion, digest/type/policy/ClamAV gates, capabilities, quarantine, deletion                                                     | Storage and scanning need operational acceptance as well as deterministic tests.                                                                           |
| [#186](https://github.com/adea-ai/adea/issues/186) | Explicit location selection, no silent failover, actual per-attempt node/location history                                                              | [#671](https://github.com/adea-ai/adea/issues/671) is closed; inspect its persisted history, writer and product surface instead of rebuilding the surface. |
| [#187](https://github.com/adea-ai/adea/issues/187) | Durable web/mobile control and outbound node connectivity, encrypted results, expiry, revocation, reconnect and deployment survival                    | Railway compute is replaceable; Neon relay state is authoritative and separate from canonical history.                                                     |
| [#188](https://github.com/adea-ai/adea/issues/188) | Self-hosted setup/registration, version/capability gates, multiple hosts, revocation, independent host operation                                       | Host deployment acceptance and product setup both remain required.                                                                                         |
| [#189](https://github.com/adea-ai/adea/issues/189) | HPKE command/result interoperability, key separation, queued rotation/revocation, replay, expiry and confidentiality                                   | Current command vectors do not establish encrypted result delivery or key lifecycle.                                                                       |

Implementation may use the pinned SDK, deterministic direct-local and remote
fixtures, relay emulators and event producers. It must exercise the same code
used by production consumers. Fixtures are independent acceptance evidence;
they do not certify a deployed Control Plane or a packaged desktop.

## Integration and release gates

[#42](https://github.com/adea-ai/adea/issues/42) and
[#130](https://github.com/adea-ai/adea/issues/130) own the linked pre-release
certification journeys. Their original criteria remain authoritative. Record
exact app, Control Plane, SDK/schema, driver/harness, encryption and storage
versions when connecting the independently accepted candidates. Control Plane
M11 being underway does not itself satisfy its release-candidate gates.

[#193](https://github.com/adea-ai/adea/issues/193) history synchronization and
[#475](https://github.com/adea-ai/adea/issues/475) remote owner-journey acceptance
remain explicit linked work. Check the owner's recorded scope decisions before
adjudicating the history clauses still present in M11 and certification issues;
do not silently waive them or equate expiring relay ciphertext with durable
Message/ContentReplica history.

For each criterion, record separately: implementation, local validation,
packaged/deployed behavior and required independent/manual acceptance. Attach
the exact command, candidate and result to evidence before marking it verified.
The ledger preserves upstream checkbox state solely as source metadata.

## First SDK increment

The web administration hop consumes `@adea-ai/sdk` 1.11.0 and
`@adea-ai/contracts` 1.14.0 directly from npm, with exact manifest pins and
lockfile integrity. Skills and cloud Connections use public operation schemas,
contract compatibility, a five-second deadline, redirect refusal and propagated
request/trace headers. Adea additionally checks its signed workspace scope and
response identity and suppresses upstream error text. Runtime SDK/schema code
cannot enter browser bundles.

[Local verification evidence](../evidence/m11-sdk-administration.md) records the
unit, database integration, compiled production Worker, browser, lint, type,
format and dependency checks for this increment.

This increment has no execution-submission or Local IPC completion claim. The
decision-resolution fixture remains a mirror for its separate contract. Next,
consume the public runtime/location read models and wire durable Task intent,
acceptance/reconciliation and event projection to the selected authority.
