import { describe, expect, test } from 'bun:test'

import { parseOutboundCompletion, summarizePublication } from '../../src/task-completion-request'

const CHANNEL = '00000000-0000-4000-8000-0000000000c1'
const ARTIFACT = '00000000-0000-4000-8000-0000000000a1'
const valid = { channelId: CHANNEL, summary: 'Approved summary.' }

describe('outbound completion request parsing', () => {
  test('accepts one canonical outbound result and defaults the artifact policy to require', () => {
    expect(parseOutboundCompletion(valid)).toEqual({
      artifact: null,
      artifactPolicy: 'require',
      channelId: CHANNEL,
      summary: 'Approved summary.',
    })
    expect(
      parseOutboundCompletion({
        ...valid,
        artifact: { artifactId: ARTIFACT, grantId: 'grant-1' },
        artifactPolicy: 'omit_unauthorized',
      })
    ).toEqual({
      artifact: { artifactId: ARTIFACT, grantId: 'grant-1' },
      artifactPolicy: 'omit_unauthorized',
      channelId: CHANNEL,
      summary: 'Approved summary.',
    })
  })

  test('refuses every malformed shape', () => {
    const refused: unknown[] = [
      null,
      'summary',
      [],
      { ...valid, extra: true },
      { ...valid, channelId: 'not-a-uuid' },
      { ...valid, channelId: undefined },
      { ...valid, summary: 42 },
      { ...valid, summary: 'x'.repeat(16_385) },
      { ...valid, artifactPolicy: 'always' },
      { ...valid, artifact: 'grant-1' },
      { ...valid, artifact: { artifactId: ARTIFACT } },
      { ...valid, artifact: { artifactId: ARTIFACT, grantId: 'grant-1', extra: 1 } },
      { ...valid, artifact: { artifactId: 'not-a-uuid', grantId: 'grant-1' } },
      { ...valid, artifact: { artifactId: ARTIFACT, grantId: '   ' } },
      { ...valid, artifact: { artifactId: ARTIFACT, grantId: 'g'.repeat(257) } },
    ]
    for (const value of refused) expect(parseOutboundCompletion(value)).toBeNull()
  })
})

describe('outbound completion response summary', () => {
  test('a publish names its message and any omitted artifact reason, never the binding', () => {
    const summary = summarizePublication({
      decision: {
        action: 'publish',
        artifactOmitted: 'grant_revoked',
        binding: { jobId: CHANNEL } as never,
        destination: { channelId: CHANNEL, workspaceId: CHANNEL },
        jobId: CHANNEL,
        result: {} as never,
      },
      messageId: 'message-1',
    })
    expect(summary).toEqual({
      action: 'publish',
      artifactOmitted: 'grant_revoked',
      messageId: 'message-1',
    })
    expect(JSON.stringify(summary)).not.toContain('binding')
  })

  test('a hold names its gate and reason, and no message', () => {
    expect(
      summarizePublication({
        decision: {
          action: 'hold',
          gate: 'artifact',
          jobId: CHANNEL,
          producerEffect: 'unaffected',
          reason: 'grant_revoked',
        },
        messageId: null,
      })
    ).toEqual({ action: 'hold', gate: 'artifact', messageId: null, reason: 'grant_revoked' })
  })
})
