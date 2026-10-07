import { describe, expect, test } from 'bun:test'

import {
  MAX_TASK_SUBMISSION_REQUEST_BYTES,
  parseTaskSubmissionInput,
  readTaskSubmissionInput,
} from '../src/server/task-submission-input'

const valid = {
  runtimeNodeId: '00000000-0000-4000-8000-000000000001',
  queueWhenOffline: true,
  profile: { id: `prf_${'0'.repeat(25)}1`, version: `pfv_${'0'.repeat(25)}1`, revision: 0 },
  envelope: { untrusted: 'parsed by the repository' },
}

const request = (body: string, headers: Record<string, string> = {}) =>
  new Request('https://adea.invalid', { method: 'POST', body, headers })

describe('Task delivery intent admission', () => {
  test('accepts only public profile, explicit offline policy and envelope metadata', () => {
    expect(parseTaskSubmissionInput(valid)).toEqual(valid)
    for (const value of [
      null,
      [],
      { ...valid, prompt: 'private' },
      { ...valid, queueWhenOffline: undefined },
      { ...valid, profile: { ...valid.profile, revision: -1 } },
      { ...valid, profile: { ...valid.profile, revision: Number.MAX_SAFE_INTEGER + 1 } },
      { ...valid, profile: { ...valid.profile, version: 'latest' } },
      { ...valid, profile: { ...valid.profile, secret: 'private' } },
      { ...valid, runtimeNodeId: 'foreign' },
    ])
      expect(parseTaskSubmissionInput(value)).toBeNull()
  })

  test('reads bounded UTF-8 JSON and rejects malformed or oversized bodies', async () => {
    expect(await readTaskSubmissionInput(request(JSON.stringify(valid)))).toEqual(valid)
    expect(await readTaskSubmissionInput(request('{'))).toBeNull()
    expect(
      await readTaskSubmissionInput(
        request(JSON.stringify(valid), {
          'content-length': String(MAX_TASK_SUBMISSION_REQUEST_BYTES + 1),
        })
      )
    ).toBeNull()
    expect(
      await readTaskSubmissionInput(
        request(' '.repeat(MAX_TASK_SUBMISSION_REQUEST_BYTES + 1), { 'content-length': '1' })
      )
    ).toBeNull()
    expect(await readTaskSubmissionInput(request('{}', { 'content-length': '-1' }))).toBeNull()
  })

  test('stops a chunked body at the actual byte limit and cancels its stream', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(512 * 1024))
      },
      cancel() {
        cancelled = true
      },
    })
    const chunkedRequest = new Request('https://adea.invalid', {
      method: 'POST',
      body,
      duplex: 'half',
    })
    expect(await readTaskSubmissionInput(chunkedRequest)).toBeNull()
    expect(cancelled).toBeTrue()
  })
})
