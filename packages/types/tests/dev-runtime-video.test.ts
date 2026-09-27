import { expect, test } from 'bun:test'

import * as runtime from '../src/dev-runtime'
import * as video from '../src/dev-runtime-video'

test('video relay helpers have a narrow module and compatible runtime exports', () => {
  expect(video.assertDevStreamRelayEnvelope).toBe(runtime.assertDevStreamRelayEnvelope)
  expect(video.decodeDevStreamRelayBase64).toBe(runtime.decodeDevStreamRelayBase64)
  expect(video.decodeDevStreamRelayVideoChunk).toBe(runtime.decodeDevStreamRelayVideoChunk)
  expect(video.encodeDevStreamVideoRelayChunks).toBe(runtime.encodeDevStreamVideoRelayChunks)
  expect(video.BROWSER_VIDEO_FRAME_BYTES_MAX).toBe(runtime.BROWSER_VIDEO_FRAME_BYTES_MAX)
})
