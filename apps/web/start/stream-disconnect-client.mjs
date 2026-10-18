import assert from 'node:assert/strict'
import { request as httpsRequest } from 'node:https'
import { setTimeout as delay } from 'node:timers/promises'

/** Exercise real guest APIs; only this run's loopback TLS certificate is trusted. */
export async function disconnectStream({ baseURL, certificate, active, label, beforeDisconnect }) {
  assert.equal(new URL(baseURL).hostname, '127.0.0.1')
  const cookies = new Map()
  const request = (path, body) =>
    new Promise((resolve, reject) => {
      const data = JSON.stringify(body ?? {})
      const req = httpsRequest(
        new URL(path, baseURL),
        {
          method: 'POST',
          ca: certificate,
          agent: false,
          headers: {
            cookie: cookieHeader(),
            origin: baseURL,
            'content-type': 'application/json',
            'idempotency-key': crypto.randomUUID(),
          },
        },
        (res) => {
          for (const cookie of res.headers['set-cookie'] ?? []) {
            const pair = cookie.split(';')[0]
            const at = pair.indexOf('=')
            cookies.set(pair.slice(0, at), pair.slice(at + 1))
          }
          let text = ''
          res.on('data', (chunk) => {
            text += chunk
          })
          res.once('end', () => {
            try {
              resolve({ status: res.statusCode, body: JSON.parse(text) })
            } catch (error) {
              reject(error)
            }
          })
          res.once('error', reject)
        }
      )
      req.setTimeout(15_000, () => req.destroy(new Error('Local API timeout')))
      req.once('error', reject)
      req.end(data)
    })
  const cookieHeader = () => [...cookies].map(([key, value]) => `${key}=${value}`).join('; ')
  const bootstrap = await request('/api/workspaces/bootstrap')
  assert.equal(bootstrap.status, 200)
  const workspaceId = bootstrap.body.activeWorkspace.id
  const project = await request(`/api/v1/workspaces/${workspaceId}/projects`, {
    name: 'Disconnect regression',
    iconKey: 'folder',
  })
  assert.equal(project.status, 201)
  const channel = await request(`/api/v1/workspaces/${workspaceId}/channels`, {
    kind: 'project',
    title: 'Local regression',
    projectId: project.body.project.id,
  })
  assert.equal(channel.status, 201)
  const channelId = channel.body.channel?.id ?? channel.body.id
  assert(channelId)
  let response
  let streamRequest
  let streamSocket
  let bytes = 0
  let streamError
  try {
    await new Promise((resolve, reject) => {
      streamRequest = httpsRequest(
        new URL(`/api/v1/workspaces/${workspaceId}/events`, baseURL),
        {
          ca: certificate,
          agent: false,
          headers: { cookie: cookieHeader(), 'x-disconnect-case': label },
        },
        (res) => {
          response = res
          res.on('data', (chunk) => {
            bytes += chunk.length
          })
          res.on('error', (error) => {
            streamError = error
          })
          if (res.statusCode !== 200) reject(new Error(`Stream status ${res.statusCode}`))
          else resolve()
        }
      )
      streamRequest.once('socket', (socket) => {
        streamSocket = socket
      })
      streamRequest.setTimeout(15_000, () =>
        streamRequest.destroy(new Error('Local stream timeout'))
      )
      streamRequest.on('error', reject)
      streamRequest.end()
    })
    // Four real mutations keep the active case at its normal delivery cadence.
    for (let index = 0; index < 4; index += 1) {
      await delay(2_000)
      if (active) {
        const message = await request(
          `/api/v1/workspaces/${workspaceId}/channels/${channelId}/messages`,
          { bodyText: `Synthetic disconnect message ${index}` }
        )
        assert([200, 201].includes(message.status))
      }
    }
    assert(bytes > 0, 'The client must consume a real stream before disconnecting')
    assert.equal(streamError, undefined)
    const databaseCheckpoint = await beforeDisconnect()
    const closed = new Promise((resolve) => streamSocket.once('close', resolve))
    const disconnectedAt = Date.now()
    response.destroy()
    streamRequest.destroy()
    streamSocket.destroy()
    await closed
    return { disconnectedAt, socketClosedAt: Date.now(), bytes, databaseCheckpoint }
  } finally {
    response?.destroy()
    streamRequest?.destroy()
    streamSocket?.destroy()
  }
}
