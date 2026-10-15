# Call-event aggregate CBOR budget repair (#1387 / PR #1399)

The reviewed head `adc65009cdf1f57f6673066f8cf39f7e20221979` bounded inline
input and output independently but did not bound their complete transport
envelope. Two valid values of `['x'.repeat(16384), 'x'.repeat(16377)]` each
encode to 32,768 JSON bytes. With the test's canonical call envelope, the whole
event encodes to **65,953 CBOR bytes**, beyond the actual **65,536-byte**
runtime-events grant. A per-field success did not prove deliverability.

## Repair

`assertRuntimeEventFrameSize` checks the actual canonical-CBOR encoding of the
entire event, including both fields, IDs, timestamps, classification and source
metadata. Versioned call validation invokes it before host-log persistence,
retention, sequence consumption, permission callbacks or subscriber delivery.
It does not raise a frame, field, hook or transport limit. A producer must use
less inline content or bounded references when an envelope does not fit.

The helper/constant are intentionally identical to the independently scoped
activity contract in PR #1405. Keep one helper/export when integrating the two
PRs; neither branch depends on the other's unmerged implementation.

## Independent regression evidence

- `packages/types/tests/dev-runtime-call-frame-budget.test.ts` validates each
  maximal field separately, measures the whole envelope with the actual CBOR
  codec, and refuses it through both generic and strict event decoders. It also
  tests exactly 65,536 bytes, same-character-count UTF-8 expansion to 65,537,
  and multibyte expansion of envelope metadata rather than payload data.
- `apps/desktop/tests/harness-events-channel.test.ts` gets the unchanged
  65,536-byte grant through the authenticated `dev.session.events` command,
  attaches a real WebSocket, and delivers exactly fitting ASCII and multibyte
  call events. The raw CBOR data frame is measured and decoded back into the
  accepted event. Combined-field, one-byte ASCII and multibyte excesses are
  rejected before append; retained rows and the sequence stay unchanged, and
  the channel remains usable. The new case creates a session only and never
  launches a harness process.
- All three new regression cases failed before the guard. A mutation omitting
  only the aggregate guard again failed all three, then was restored. The full
  two-file run also preserves the existing grant/replay/ack/generation test:
  **4 pass, 0 fail** with the repair.

Reproduce with pinned Bun 1.4.0:

```sh
bun test packages/types/tests/dev-runtime-call-frame-budget.test.ts apps/desktop/tests/harness-events-channel.test.ts
```

This is source/fixture transport evidence, not native producer or packaged
qualification. No production call emitter is introduced and no success,
permission eligibility or producer fact is invented by the size check.
