// TEST ONLY. Keep CP's decorated source in its own supported Bun/compiler process.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Escalation is restricted to the exact ChildProcess handle spawned by this fixture. */
export async function stopOwnedCandidateProcess(child, stopped, graceMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const graceful = await new Promise((done) => {
    const timeout = setTimeout(() => done(false), graceMs)
    stopped.then(() => {
      clearTimeout(timeout)
      done(true)
    })
  })
  if (!graceful) {
    child.kill('SIGKILL')
    await stopped
  }
}

export async function startCandidateLeadHostProcess(entry, options) {
  const root = resolve(dirname(entry), '../../../../')
  const logs = await mkdtemp(join(tmpdir(), 'adea-cp-host-'))
  const stderr = createWriteStream(join(logs, 'stderr.log'))
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: {
      ...process.env,
      PI_CANDIDATE_WORKSPACE_ID: options.workspaceId,
      PI_CANDIDATE_WORKSPACE_SCOPE: String(options.workspaceScope === true),
      PI_CANDIDATE_PREPARE_FUNDING: String(options.prepareFunding === true),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr.pipe(stderr)
  let exited = false
  const stopped = new Promise((done) => {
    child.once('exit', () => {
      exited = true
      done()
    })
    child.once('error', () => {
      exited = true
      done()
    })
  })
  let metadata
  async function request(path, body) {
    const response = await fetch(new URL(path, metadata.baseUrl), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${metadata.testCredential}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    })
    assert.ok(response.ok, `Candidate control rejected: ${response.status}`)
    return response.json()
  }
  async function close() {
    try {
      if (!exited && metadata) await request('/__candidate/close', {}).catch(() => {})
      if (!exited) await stopOwnedCandidateProcess(child, stopped)
    } finally {
      stderr.end()
    }
  }
  try {
    metadata = await new Promise((done, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`CANDIDATE_PROCESS_START_TIMEOUT:${logs}`)),
        120_000
      )
      let buffer = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (text) => {
        buffer += text
        if (buffer.length > 1_048_576) reject(new Error('CANDIDATE_METADATA_TOO_LARGE'))
        for (const line of buffer.split('\n').slice(0, -1)) {
          if (!line.startsWith('{')) continue
          try {
            const value = JSON.parse(line)
            if (value.baseUrl) {
              clearTimeout(timeout)
              done(value)
            }
          } catch {}
        }
      })
      stopped.then(() => {
        clearTimeout(timeout)
        reject(new Error(`CANDIDATE_PROCESS_EXITED:${logs}`))
      })
    })
    const url = new URL(metadata.baseUrl)
    assert.equal(url.protocol, 'http:')
    assert.equal(url.hostname, '127.0.0.1')
    assert.equal(metadata.workspaceId, options.workspaceId)
    assert.equal(metadata.sourceIdentity.head, options.expectedHead)
    assert.equal(
      metadata.sourceIdentity.wipDigest,
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    )
    return {
      ...metadata,
      registerIntent: (evidence) => request('/__candidate/intents', evidence),
      metrics: async () => (await request('/__candidate/evidence')).metrics,
      inspectAdmissionRecordCounts: async () => (await request('/__candidate/evidence')).metrics,
      evidence: (intentId) =>
        request(`/__candidate/evidence?intentId=${encodeURIComponent(intentId)}`),
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
