# Hosted Sim bridge follow-up proposal

Status: proposed for the existing bridge owner and lead coordination. No change
to the owned bridge or hosted-component files is included in this proposal.
Production authority and rollout decisions are separate.

## Reproduced compatibility gaps

1. The current closed bridge has `frame.close` but no navigation intent. The
   private HQ engine's room/character controls cannot ask the parent to perform
   the new surface launch. Direct host designer routes have their own launch,
   but that does not repair the controls inside HQ.
2. The private character designer's save callback writes `character` to its own
   `window.location` using `history.replaceState`, then resolves success. In an
   iframe that updates a disposable child URL, not the parent route/state.
   Closing and reopening therefore restores the parent's old character.
3. The private serializer emits `character:v1:` followed by 13 pipe-separated
   slots. The current default serialized value is 157 characters long. Passing
   that actual value to `parseHostMessage` returns `invalid_payload`: the current
   character rule allows only 1–64 `[A-Za-z0-9_.:-]` characters. The host controller
   forwards the value unchanged; the frame refuses it. Trimming, dropping it,
   encoding it as an unrelated catalog ID, or increasing the limit without
   validating its structure would not preserve customization semantics.

These are source and local parser proofs, not a live-production reproduction.
The private source and asset catalog remain in their existing private repository.

## Narrow contract to agree before implementation

Use an explicit version/capability decision owned by the bridge maintainer. Do
not silently reinterpret `frame.close` or introduce a generic RPC channel.

- **Navigation intent:** a closed `frame.navigate` message with a bounded
  request ID and target `room-designer` or `character-designer`. The host accepts
  it only from the current exact frame/window/nonce, retains its current
  workspace/scene authority, disposes the old frame, and obtains a fresh grant
  for the requested surface. No grant/code/session may be reused across surfaces.
- **Character value:** preserve short catalog IDs and add a separately parsed
  `character:v1:` form with exactly the established 13 slots, explicit empty-slot
  token, and finite per-slot/total limits. Audit the actual private catalog and
  serializer to choose those limits rather than guessing. Keep the bridge's
  overall size/depth/node budget finite. The public protocol need not publish
  the private catalog. The private engine still validates actual catalog membership.
- **Save intent:** a closed `frame.character.save` message with bounded request
  ID and validated character value. The host updates its existing canonical
  character URL/router state under the current workspace, then answers a typed
  `host.character.save.result` for that request/attempt. No account identity,
  credential, arbitrary URL, filesystem operation, or native command is added.
- **Acknowledged save:** add an optional async `onSave` to the private character
  mount contract. In hosted mode the engine must await the correlated host
  result before displaying success. The standalone same-origin mount may retain
  its existing URL fallback. Timeout, route cancellation, refusal, and disposal
  resolve failure; they never report a saved value.
- **Callbacks:** the hosted component exposes narrow `onNavigate` and
  `onCharacterSave` hooks. The app owner wires those to existing router actions;
  the shared component does not invent persistence, account policy, or a hostname.

## Required joined acceptance

Use the actual private character designer, not only an engine fixture:

1. Open HQ, use its room/character controls, and observe a new grant bound to the
   requested surface while stale frame messages remain ignored.
2. Open a supported serialized customization, change a real part, save, and wait
   for the parent's acknowledged canonical state change.
3. Close the frame and reopen the designer; assert the edited value/part remains.
   Reload the parent and repeat to exercise the existing URL persistence contract.
4. Refuse malformed/oversized/unknown-slot configurations and foreign or stale
   save/navigation messages. Refused or timed-out saves must not show success.
5. Repeat offline and on reconnect; Chat/Dev stay independent and no stale grant
   or late save result may update the next attempt/workspace.

The bridge owner must release or implement its owned files before the app owner
overlaps them. Until this contract and the joined persistence proof land, the
hosted customization/navigation journey remains incomplete and the PR stays draft.
