# Browser caller and frame-transport gaps (#718/#735)

This note records the boundaries between the browser operations already
implemented by Dev Runtime and the BrowserPane callers. It distinguishes DOM
inspection from preview pixels so that a selector query is not presented as a
visual picker.

## Existing typed operations

- `dev.browser.inspect` is a `dev.browser.read` operation bound to a
  `browser_lane` resource. Its strict body carries `browserLaneId`,
  `expectedGeneration`, `targetId`, and an optional selector. The host verifies
  lane scope and generation; the CDP engine limits selectors to 512 characters
  and a safe CSS-selector grammar. `BrowserInspection` returns the target,
  optional node ID, role, name, and bounds.
- `dev.browser.attach` grants a read-direction `browser-frames-v1` stream bound
  to the lane resource and generation. `dev.browser.input` is a separate
  write-direction stream requiring `dev.browser.control`; attaching for read
  does not grant input authority.
- `dev.browser.screenshot` returns a `ScreenshotRef`, not image bytes. The host
  store retains bounded bytes, but the BrowserPane currently discards the
  reference. `dev.browser.annotate` requires `dev.browser.control`, captures a
  screenshot, and returns an annotation reference; capture provenance currently
  says `redacted: false` because no redaction pass runs.

## Caller status

The BrowserPane selector inspector calls `dev.browser.inspect` for the active
page target only when target lane ID and generation match the selected lane.
Its command includes the same generation-bound resource, and a late result is
discarded if the lane, target, or selector changes. It displays the returned
role, name, and bounds, or an explicit no-match result. This is a DOM query; it
does not infer a target from pixels or claim click-to-pick support.

The BrowserPane does not yet consume `dev.browser.attach` or render a live
frame. Its floating preview remains a placeholder. The Screenshot button
captures metadata but does not display bytes; the annotation affordance does
not yet submit a coordinate annotation. These controls need the stream/image
boundary below before they can be truthful visual tools.

## Broken frame producer-consumer path

The CDP engine publishes `DevStreamFrame` values with `type: 'video'` and a
complete encoded image, up to the existing 8 MiB frame budget. The screencast
pacer already limits publication to 15 FPS by default, 30 maximum, 4096×4096,
one in-flight plus the newest complete frame, and 240 input events per second.
However, both JSON relay unions (`stream-relay.ts` in the shell and
`desktop-stream-transport.ts` in the web client) omit `video`; the shell relay
codec's default branch rejects it. The client has no video-to-image consumer.
The relay also caps decoded frame payloads at 128 KiB. Sending one complete
image through a command reply or a single relay frame would violate that bound
and turn the control path into an unbounded data path.

There is a second release blocker for pixel display: screenshot and annotation
provenance is explicitly `redacted: false`. Until the host classifies and
redacts captured page pixels, the UI must not project those pixels as a trusted
preview or claim that annotation coordinates correspond to a reviewed image.

## Smallest bounded amendment

Keep the existing `browser-frames-v1` grant and its read/write capability
separation. Extend the **stream relay frame** codec with a strict video-chunk
representation rather than adding image bytes to DevCommand replies or
workspace events. The 128 KiB relay bound can carry 64 KiB raw chunks (about
88 KiB after base64, before the small header) with room for envelope overhead.
Every chunk should bind to the already-authenticated stream generation and
carry a frame sequence, chunk index/count or byte offset, total frame length,
timestamp, viewport sequence, keyframe flag, dimensions, and bytes. The host
must include the existing viewport sequence and dimensions in this relay
envelope so a completed frame cannot be mistaken for the current emulation.

The shell encoder and web decoder must enforce the same rules: raw chunk at
most 64 KiB; total frame at most the existing 8 MiB; dimensions at most
4096×4096; no more than 128 chunks per frame; contiguous offsets and stable
metadata; monotonic frame sequence; exact generation match; and rejection of
duplicates, gaps, malformed lengths, stale generations, and oversize values.
Reassembly must hold at most one incomplete frame per stream, discard it on
timeout/close/generation change, and preserve the existing one-in-flight plus
one-newest publication bound. Credit/acknowledgment should advance only after
the complete frame is accepted by the renderer; partial chunks must not be
acknowledged as a rendered frame. Raw image bytes must stay out of logs and
durable events.

Only after an explicit host redaction/classification result authorizes display
should the BrowserPane attach the read grant, decode a complete frame, and
render it. Input and annotation still require their independent control grant,
current lane generation, and existing input rate limit. Tests should cover
strict codec parity, bounded reassembly and cleanup, stale-generation refusal,
slow-consumer backpressure, renderer acknowledgment, and the mounted pane's
attach/unsubscribe lifecycle. Until that transport and redaction gate exist,
selector-based DOM inspection is the supported inspection surface; screenshots
and visual annotations remain unavailable in the pane.
