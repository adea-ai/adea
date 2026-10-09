import { describe, expect, test } from 'bun:test'

import {
  JOB_OUTBOUND_SENDER_PREFIX,
  decodeJobOutboundBinding,
  encodeJobOutboundBinding,
  summarySha256,
  type JobOutboundBinding,
} from '../../src/job-outbound-binding'

/** The publication binding codec: the only accepted form of a canonical publication sender. */

const CHECKSUM = 'a'.repeat(64)

const plain: JobOutboundBinding = {
  actorUserId: 'user-actor',
  artifact: null,
  channelId: 'channel-a',
  channelVersion: 4,
  grant: null,
  jobId: 'job-1',
  summarySha256: summarySha256('Done.'),
  workspaceId: 'ws-dest',
}

const linked: JobOutboundBinding = {
  ...plain,
  artifact: {
    artifactId: 'artifact-1',
    checksumSha256: CHECKSUM,
    sourceWorkspaceId: 'ws-source',
    version: 3,
  },
  grant: { grantId: 'grant-1', revision: 2 },
}

describe('job outbound publication binding', () => {
  test('round-trips a plain and an artifact-bearing binding', () => {
    expect(decodeJobOutboundBinding(encodeJobOutboundBinding(plain))).toEqual(plain)
    expect(decodeJobOutboundBinding(encodeJobOutboundBinding(linked))).toEqual(linked)
  })

  test('refuses a value without the system prefix, or with an unparseable body', () => {
    expect(decodeJobOutboundBinding(null)).toBeNull()
    expect(decodeJobOutboundBinding('plain sender')).toBeNull()
    expect(decodeJobOutboundBinding(`${JOB_OUTBOUND_SENDER_PREFIX}not-base64-json!`)).toBeNull()
  })

  test('refuses an alternative spelling of the same fields (canonical form only)', () => {
    const reordered = Buffer.from(
      JSON.stringify(Object.fromEntries(Object.entries(canonicalOf(plain)).toReversed()))
    ).toString('base64url')
    const withSpace = `${JOB_OUTBOUND_SENDER_PREFIX}${Buffer.from(
      JSON.stringify(plain, null, 1)
    ).toString('base64url')}`
    expect(decodeJobOutboundBinding(encodeJobOutboundBinding(plain))).not.toBeNull()
    expect(decodeJobOutboundBinding(`${JOB_OUTBOUND_SENDER_PREFIX}${reordered}`)).toBeNull()
    expect(decodeJobOutboundBinding(withSpace)).toBeNull()
  })

  test('refuses malformed fields: bad revision, bad digest, an artifact without a grant', () => {
    expect(
      decodeJobOutboundBinding(encode({ ...canonicalOf(plain), channelVersion: 0 }))
    ).toBeNull()
    expect(
      decodeJobOutboundBinding(encode({ ...canonicalOf(plain), summarySha256: 'zz' }))
    ).toBeNull()
    expect(decodeJobOutboundBinding(encode({ ...canonicalOf(linked), grant: null }))).toBeNull()
    expect(
      decodeJobOutboundBinding(
        encode({ ...canonicalOf(plain), grant: { grantId: 'g', revision: 1 } })
      )
    ).toBeNull()
  })
})

/** The canonical JSON shape of a binding, used to forge malformed encodings in tests. */
function canonicalOf(binding: JobOutboundBinding) {
  return JSON.parse(JSON.stringify(binding)) as Record<string, unknown>
}

/** Forges a sender value from arbitrary JSON, for the malformed-field cases. */
function encode(value: unknown): string {
  return `${JOB_OUTBOUND_SENDER_PREFIX}${Buffer.from(JSON.stringify(value)).toString('base64url')}`
}
