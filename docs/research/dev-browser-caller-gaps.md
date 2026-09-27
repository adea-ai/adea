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
  and a safe CSS-selector grammar on both page and frame targets. Invalid CSS
  reported by CDP surfaces as an error instead of being confused with a
  no-match result. `BrowserInspection` returns the target, optional node ID,
  role, name, and bounds.
- `dev.browser.attach` grants a read-direction `browser-frames-v1` stream bound
  to the lane resource and generation. `dev.browser.input` is a separate
  write-direction stream requiring `dev.browser.control`; attaching for read
  does not grant input authority.
- `dev.browser.screenshot` returns a `ScreenshotRef`, not image bytes. The host
  store retains bounded bytes, and the BrowserPane now shows only the returned
  reference ID, dimensions, content type, expiry, and exact `redacted` boolean.
  It never requests or renders bytes, and discards results after capture-context
  changes or unmount. The current host screenshot provenance is `redacted: false`;
  this metadata result is not permission to display pixels. `dev.browser.annotate`
  requires `dev.browser.control`, captures a screenshot, and returns an annotation
  reference; its capture provenance currently says `redacted: false` because no
  redaction pass runs.

## Caller status

The BrowserPane selector inspector calls `dev.browser.inspect` for the active
page target only when target lane ID and generation match the selected lane.
Its command includes the same generation-bound resource, and a late result is
discarded if the lane, target, selector, or emulated viewport changes. It
displays the returned role, name, and bounds, or an explicit no-match result.
This is a DOM query; it does not infer a target from pixels or claim
click-to-pick support.

The BrowserPane does not yet consume `dev.browser.attach` or render a live
frame. Its floating preview remains a placeholder. The Screenshot action now
returns a metadata-only result, not a visual preview. The annotation affordance
does not yet submit a coordinate annotation. These controls need the
stream/image boundary below before they can be truthful visual tools.

## Broken frame producer-consumer path

The CDP engine publishes `DevStreamFrame` values with `type: 'video'` and a
complete encoded image and stamps generation, viewport sequence, dimensions,
and capture time. The screencast pacer limits publication to 15 FPS by
default, 30 maximum, 4096×4096, one in-flight plus the newest complete frame,
and 240 input events per second. The authenticated shell event relay now
encodes a frame as strict `video_chunk` envelopes: at most 64 KiB raw per
chunk, 128 KiB serialized envelope, 8 MiB / 128 chunks per complete frame,
and dimensions at most 4096×4096. The web transport strictly validates and
reassembles contiguous chunks with stable metadata, monotonic sequence, and
the grant's generation before it invokes a frame consumer. It holds at most
one incomplete frame per attached stream and discards partial state on
timeout, close, or generation mismatch. A reassembly timeout reports a
retryable typed `timeout` and tears down the relay so the caller can obtain a
fresh grant and attach again. It does not emit credit for partial chunks; the
consumer's existing read-grant ACK remains a separate client action after
full-frame acceptance.

There is a second release blocker for pixel display: screenshot and annotation
provenance is explicitly `redacted: false`. Until the host classifies and
redacts captured page pixels, the UI must not project those pixels as a trusted
preview or claim that annotation coordinates correspond to a reviewed image.

## Remaining pixel-display gate

The transport amendment does not mount the stream in BrowserPane or render
pixels. Screenshot and annotation provenance still says `redacted: false`; the
pane must remain closed to image projection until the host supplies an
explicit redaction/classification result that authorizes display. A later UI
change must attach the read grant, decode a complete current frame, render it,
and unsubscribe on lane/generation changes. Input and annotation continue to
require their independent control grant, current lane generation, and existing
input rate limit. Until that host redaction gate and mounted consumer exist,
selector-based DOM inspection remains the supported inspection surface;
screenshots and visual annotations remain unavailable in the pane. The
transport has unit-level authenticated-relay and web-reassembly coverage, not
native WebView display or redaction qualification.
