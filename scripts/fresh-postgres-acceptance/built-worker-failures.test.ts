import { describe, expect, test } from 'bun:test'

import {
  BUILT_WORKER_FAILURE_KINDS,
  BuiltWorkerFailure,
  failureMessage,
  publishedReceipt,
  sanitizeText,
  sanitizeValue,
  sanitizeWorkerLogs,
  withoutTopLevelField,
} from './built-worker-failures'

const SECRET = 'adea-auth-secret-0123456789abcdef'
const PASSWORD = 'adea-instance-password-0123456789'

describe('the built-Worker failure sanitization', () => {
  test('a known secret never survives the sanitization', () => {
    const text = sanitizeText(`the connection to postgres failed with ${SECRET}`, [SECRET])
    expect(text).not.toContain(SECRET)
    expect(text).toContain('[redacted]')
  })

  test('an encoded secret never survives the sanitization', () => {
    const encoded = encodeURIComponent(SECRET)
    const text = sanitizeText(`the url carried ${encoded}`, [SECRET])
    expect(text).not.toContain(encoded)
  })

  test('a password in a URL never survives the sanitization', () => {
    const text = sanitizeText(
      `the driver could not reach postgresql://adea:${PASSWORD}@127.0.0.1:5432/adea_ci`,
      [PASSWORD]
    )
    expect(text).not.toContain(PASSWORD)
    expect(text).toContain('[redacted]')
  })

  test('a secret in an assignment never survives the sanitization', () => {
    const text = sanitizeText('AUTH_SECRET=super-secret-value and password: "another-value"')
    expect(text).not.toContain('super-secret-value')
    expect(text).not.toContain('another-value')
  })

  test('a cookie in a header never survives the sanitization', () => {
    const text = sanitizeText('set-cookie: session_token=the-session-value; Path=/')
    expect(text).not.toContain('the-session-value')
  })

  test('the sanitized text is bounded', () => {
    const text = sanitizeText('x'.repeat(10_000))
    expect(text.length).toBeLessThanOrEqual(400)
  })

  test('the runtime logs keep only the failure lines, and they are redacted', () => {
    const logs = sanitizeWorkerLogs(
      [
        '[wrangler:info] Ready on https://127.0.0.1:8790',
        `ERROR the auth service failed with ${SECRET}`,
        'ERROR the connection to postgresql://adea:supersecretvalue@127.0.0.1:5432 broke',
      ],
      [SECRET]
    )
    expect(logs.length).toBe(2)
    expect(logs.join(' ')).not.toContain(SECRET)
    expect(logs.join(' ')).not.toContain('supersecretvalue')
    expect(logs.join(' ')).not.toContain('Ready on')
  })

  test('the runtime logs are bounded', () => {
    const logs = sanitizeWorkerLogs(
      Array.from({ length: 50 }, (_value, index) => `ERROR failure ${index}`)
    )
    expect(logs.length).toBeLessThanOrEqual(5)
  })
})

describe('the built-Worker receipt sanitization', () => {
  test('a URL query credential never survives the sanitization', () => {
    const text = sanitizeText('/error?token=SYNTHETIC_SECRET&state=kept')
    expect(text).not.toContain('SYNTHETIC_SECRET')
    expect(text).toContain('token=[redacted]')
    expect(text).toContain('state=kept')
  })

  test('a quoted JSON secret field never survives the sanitization', () => {
    const text = sanitizeText('{"credential":"SYNTHETIC_SECRET","error":"refused"}')
    expect(text).not.toContain('SYNTHETIC_SECRET')
    expect(text).toContain('refused')
  })

  test('every string of a nested value tree is sanitized', () => {
    const sanitized = sanitizeValue({
      detail: '/error?token=SYNTHETIC_SECRET',
      nested: { deeper: ['{"credential":"SYNTHETIC_SECRET"}'] },
    })
    expect(JSON.stringify(sanitized)).not.toContain('SYNTHETIC_SECRET')
  })

  test('the published receipt carries the verdict and no value', () => {
    const published = publishedReceipt({
      receipt: {
        status: 'failed',
        assertions: [{ name: 'a', passed: false, detail: '{"credential":"SYNTHETIC_SECRET"}' }],
      },
      verdict: { workerStopped: true, containerRemoved: true, materialRemoved: true },
    })
    expect(JSON.stringify(published)).not.toContain('SYNTHETIC_SECRET')
    expect(published.cleanup.workerStopped).toBe(true)
    expect(published.cleanup.materialRemoved).toBe(true)
  })
})

describe('the built-Worker top-level field removal', () => {
  test('the first top-level occurrence is removed', () => {
    const body = '{"credential":"first","other":"kept"}'
    expect(withoutTopLevelField(body, 'credential')).toBe('{"other":"kept"}')
  })

  test('a duplicate occurrence stays in the text', () => {
    const body = '{"credential":"first","credential":"second"}'
    expect(withoutTopLevelField(body, 'credential')).toContain('second')
  })

  test('a nested occurrence stays in the text', () => {
    const body = '{"data":{"credential":"nested"},"credential":"top"}'
    expect(withoutTopLevelField(body, 'credential')).toContain('nested')
  })

  test('a field that is not there leaves the text alone', () => {
    const body = '{"other":"kept"}'
    expect(withoutTopLevelField(body, 'credential')).toBe(body)
  })

  test('a body that is not JSON leaves the text alone', () => {
    const body = 'not json at all'
    expect(withoutTopLevelField(body, 'credential')).toBe(body)
  })
})

describe('the built-Worker failure kinds', () => {
  test('the vocabulary is fixed', () => {
    expect(BUILT_WORKER_FAILURE_KINDS).toContain('transport-failed')
    expect(BUILT_WORKER_FAILURE_KINDS).toContain('application-failure')
    expect(BUILT_WORKER_FAILURE_KINDS).toContain('infrastructure-failure')
    expect(BUILT_WORKER_FAILURE_KINDS).toContain('worker-stop-failed')
    expect(BUILT_WORKER_FAILURE_KINDS).toContain('cleanup-failed')
    expect(new Set(BUILT_WORKER_FAILURE_KINDS).size).toBe(BUILT_WORKER_FAILURE_KINDS.length)
  })

  test('a failure publishes its kind and a redacted detail', () => {
    const failure = new BuiltWorkerFailure('transport-failed', `the socket carried ${SECRET}`, {
      secrets: [SECRET],
    })
    expect(failure.kind).toBe('transport-failed')
    expect(failure.detail).not.toContain(SECRET)
    expect(failureMessage(failure)).toContain('transport-failed')
    expect(failureMessage(failure)).not.toContain(SECRET)
  })

  test('a failure without a detail still names its kind', () => {
    const failure = new BuiltWorkerFailure('cleanup-failed')
    expect(failureMessage(failure)).toContain('cleanup-failed')
  })
})
