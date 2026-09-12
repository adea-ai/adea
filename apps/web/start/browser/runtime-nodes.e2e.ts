import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test'

// Runtime node identity against the real isolated backend. A guest owns the
// workspace it bootstraps, so it holds `runtime.invoke`. Every signature below
// is made with a real Ed25519 key: the host must verify what an independent
// signer produced, so a stubbed verifier would prove nothing here.

/**
 * The isolated lane serves the worker through workerd's local TLS listener, and
 * a pooled connection the listener has already closed comes back as a miniflare
 * 500 whose body is a transport error rather than an app response. This suite
 * makes far more requests than the rest of the lane, so it retries that one
 * case; every other outcome, including a 500 from the route handlers, is
 * returned untouched.
 */
class Client {
  constructor(private readonly context: APIRequestContext) {}

  async get(path: string, options?: Parameters<APIRequestContext['get']>[1]) {
    return this.retrying(() => this.context.get(path, options))
  }

  async post(path: string, options?: Parameters<APIRequestContext['post']>[1]) {
    return this.retrying(() => this.context.post(path, options))
  }

  async fetch(path: string, options?: Parameters<APIRequestContext['fetch']>[1]) {
    return this.retrying(() => this.context.fetch(path, options))
  }

  dispose() {
    return this.context.dispose()
  }

  private async retrying(send: () => Promise<APIResponse>) {
    let response = await send()
    for (let attempt = 0; attempt < 3 && (await transportLoss(response)); attempt += 1) {
      response = await send()
    }
    return response
  }
}

async function transportLoss(response: APIResponse) {
  if (response.status() !== 500) return false
  return (await response.text()).includes('Network connection lost')
}

const KEY_FIELDS = [
  'algorithm',
  'fingerprint',
  'keyVersion',
  'publicKey',
  'retiredAt',
  'role',
  'verifiedAt',
]

async function keypair() {
  const pair = (await crypto.subtle.generateKey('Ed25519' as never, true, [
    'sign',
    'verify',
  ] as never)) as unknown as CryptoKeyPair
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer)
  return {
    publicKey: Buffer.from(raw).toString('base64url'),
    sign: async (message: string) =>
      Buffer.from(
        (await crypto.subtle.sign(
          'Ed25519' as never,
          pair.privateKey,
          new TextEncoder().encode(message)
        )) as ArrayBuffer
      ).toString('base64url'),
  }
}

/** An unrelated 32-byte value: the host stores the X25519 key, it never signs. */
function encryptionKey(seed: string) {
  return Buffer.from(seed.padEnd(32, '.').slice(0, 32)).toString('base64url')
}

function keys(signingPublicKey: string, encryptionSeed: string) {
  return [
    { algorithm: 'ed25519', publicKey: signingPublicKey, role: 'signing' },
    {
      algorithm: 'x25519',
      publicKey: encryptionKey(encryptionSeed),
      role: 'command_encryption',
    },
  ]
}

async function guest(context: Client) {
  const bootstrap = await context.post('/api/workspaces/bootstrap')
  expect(bootstrap.status()).toBe(200)
  const body = await bootstrap.json()
  return body.activeWorkspace.id as string
}

async function pairedNode(response: APIResponse) {
  expect(response.status()).toBe(200)
  return (await response.json()) as { node: { id: string; kind: string; keys: unknown[] } }
}

test('a device pairs, proves liveness, rotates its key, and is revoked', async ({
  playwright,
  baseURL,
}) => {
  const options = {
    baseURL,
    ignoreHTTPSErrors: ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseURL!).hostname),
  }
  const own = new Client(await playwright.request.newContext(options))
  const foreign = new Client(await playwright.request.newContext(options))
  try {
    const workspaceId = await guest(own)
    const nodesUrl = `/api/v1/workspaces/${workspaceId}/runtime-nodes`
    expect((await (await own.get(nodesUrl)).json()).nodes).toEqual([])
    expect((await foreign.post('/api/workspaces/bootstrap')).status()).toBe(200)

    // Pairing: the node signs the challenge the server issued for this workspace.
    const signing = await keypair()
    const registration = {
      displayName: 'Playwright laptop',
      kind: 'local_device',
      keys: keys(signing.publicKey, 'playwright-encryption'),
      platform: 'macOS 26.0 arm64',
      softwareVersion: '0.20.0',
      trustMetadata: { arch: 'arm64' },
    }
    const pairing = await own.post(nodesUrl, { data: { kind: 'local_device' } })
    expect(pairing.status()).toBe(200)
    const pairChallenge = (await pairing.json()).challenge
    const { node } = await pairedNode(
      await own.post(`${nodesUrl}/pair`, {
        data: {
          ...registration,
          challengeId: pairChallenge.challengeId,
          signature: await signing.sign(
            `adea-runtime-node-pairing:v1:local_device:${workspaceId}:${pairChallenge.challengeId}:${pairChallenge.nonce}`
          ),
        },
      })
    )
    const listed = (await (await own.get(nodesUrl)).json()).nodes
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      displayName: 'Playwright laptop',
      health: 'healthy',
      kind: 'local_device',
      pairingState: 'paired',
      platform: 'macOS 26.0 arm64',
    })
    // Pairing is itself a proof of possession, so the node is already seen.
    expect(listed[0].lastProofAt).toBeTruthy()
    // The read model is public material only: no private key ever crosses the wire.
    for (const key of listed[0].keys) expect(Object.keys(key).toSorted()).toEqual(KEY_FIELDS)
    expect(listed[0].keys.every((key: { verifiedAt: string | null }) => key.verifiedAt)).toBe(true)

    // A proof signed by a key nobody registered is refused, and the refusal does
    // not burn the challenge: the same challenge still pairs a real device.
    const impostor = await keypair()
    const secondPairing = await own.post(nodesUrl, { data: { kind: 'local_device' } })
    const secondChallenge = (await secondPairing.json()).challenge
    expect(
      (
        await own.post(`${nodesUrl}/pair`, {
          data: {
            ...registration,
            challengeId: secondChallenge.challengeId,
            keys: keys(impostor.publicKey, 'playwright-impostor'),
            signature: await impostor.sign('adea-runtime-node-pairing:v1:local_device:forged'),
          },
        })
      ).status()
    ).toBe(400)
    const secondDevice = await pairedNode(
      await own.post(`${nodesUrl}/pair`, {
        data: {
          ...registration,
          challengeId: secondChallenge.challengeId,
          displayName: 'Playwright tablet',
          keys: keys(impostor.publicKey, 'playwright-impostor'),
          signature: await impostor.sign(
            `adea-runtime-node-pairing:v1:local_device:${workspaceId}:${secondChallenge.challengeId}:${secondChallenge.nonce}`
          ),
        },
      })
    )
    expect(secondDevice.node.id).not.toBe(node.id)

    // Liveness: the proof must come from the registered key, not a presented one.
    const challengesUrl = `${nodesUrl}/${node.id}/challenges`
    const livenessChallenge = (
      await (await own.post(challengesUrl, { data: { purpose: 'proof' } })).json()
    ).challenge
    const proofMessage = (challengeId: string, nonce: string) =>
      `adea-runtime-node-proof:v1:${node.id}:${challengeId}:${nonce}`
    expect(
      (
        await own.post(`${nodesUrl}/${node.id}/proof`, {
          data: {
            challengeId: livenessChallenge.challengeId,
            signature: await impostor.sign(
              proofMessage(livenessChallenge.challengeId, livenessChallenge.nonce)
            ),
          },
        })
      ).status()
    ).toBe(400)
    const proved = await own.post(`${nodesUrl}/${node.id}/proof`, {
      data: {
        challengeId: livenessChallenge.challengeId,
        signature: await signing.sign(
          proofMessage(livenessChallenge.challengeId, livenessChallenge.nonce)
        ),
      },
    })
    expect(proved.status()).toBe(200)
    expect((await proved.json()).proof.lastProofAt).toBeTruthy()
    const healthy = (await (await own.get(nodesUrl)).json()).nodes.find(
      (item: { id: string }) => item.id === node.id
    )
    expect(healthy.health).toBe('healthy')

    // Rotation: the replacement key signs its own rotation, so the old key can
    // retire while the new one is already proven.
    const rotatedKeys = await keypair()
    const rotateMessage = (challengeId: string, nonce: string) =>
      `adea-runtime-node-rotation:v1:${node.id}:${challengeId}:${nonce}`
    const rotationChallenge = (
      await (await own.post(challengesUrl, { data: { purpose: 'rotate' } })).json()
    ).challenge
    // A replacement signed by the key it is meant to replace is refused, and the
    // refusal leaves the challenge usable: the same challenge rotates below.
    expect(
      (
        await own.post(`${nodesUrl}/${node.id}/rotate`, {
          data: {
            challengeId: rotationChallenge.challengeId,
            keys: keys(rotatedKeys.publicKey, 'playwright-encryption-2'),
            signature: await signing.sign(
              rotateMessage(rotationChallenge.challengeId, rotationChallenge.nonce)
            ),
          },
        })
      ).status()
    ).toBe(400)
    const rotated = await pairedNode(
      await own.post(`${nodesUrl}/${node.id}/rotate`, {
        data: {
          challengeId: rotationChallenge.challengeId,
          keys: keys(rotatedKeys.publicKey, 'playwright-encryption-2'),
          signature: await rotatedKeys.sign(
            rotateMessage(rotationChallenge.challengeId, rotationChallenge.nonce)
          ),
        },
      })
    )
    expect(rotated.node.id).toBe(node.id)
    const rotatedView = (await (await own.get(nodesUrl)).json()).nodes.find(
      (item: { id: string }) => item.id === node.id
    )
    expect(
      rotatedView.keys.filter((key: { retiredAt: string | null }) => !key.retiredAt)
    ).toHaveLength(2)
    expect(
      rotatedView.keys.find((key: { role: string }) => key.role === 'signing').keyVersion
    ).toBe(2)

    // The retired key no longer proves liveness; the replacement does.
    const afterRotation = (
      await (await own.post(challengesUrl, { data: { purpose: 'proof' } })).json()
    ).challenge
    expect(
      (
        await own.post(`${nodesUrl}/${node.id}/proof`, {
          data: {
            challengeId: afterRotation.challengeId,
            signature: await signing.sign(
              proofMessage(afterRotation.challengeId, afterRotation.nonce)
            ),
          },
        })
      ).status()
    ).toBe(400)
    const currentProof = (
      await (await own.post(challengesUrl, { data: { purpose: 'proof' } })).json()
    ).challenge
    expect(
      (
        await own.post(`${nodesUrl}/${node.id}/proof`, {
          data: {
            challengeId: currentProof.challengeId,
            signature: await rotatedKeys.sign(
              proofMessage(currentProof.challengeId, currentProof.nonce)
            ),
          },
        })
      ).status()
    ).toBe(200)

    // A foreign workspace cannot see or drive this node: no challenge is issued
    // and the identity is not disclosed.
    expect((await foreign.get(nodesUrl)).status()).toBe(404)
    expect(
      (
        await foreign.post(`${nodesUrl}/${node.id}/challenges`, { data: { purpose: 'proof' } })
      ).status()
    ).toBe(404)
    expect(
      (
        await foreign.post(`${nodesUrl}/${node.id}/revoke`, { data: { reason: 'not mine' } })
      ).status()
    ).toBe(404)

    // Revocation keeps the record, blocks further challenges, and keeps the keys
    // readable for audit.
    const revoked = await own.post(`${nodesUrl}/${node.id}/revoke`, {
      data: { reason: 'Sold the laptop' },
    })
    expect(revoked.status()).toBe(200)
    expect((await revoked.json()).node).toMatchObject({
      pairingState: 'revoked',
      revocationReason: 'Sold the laptop',
    })
    expect((await own.post(challengesUrl, { data: { purpose: 'proof' } })).status()).toBe(404)
    const afterRevocation = (await (await own.get(nodesUrl)).json()).nodes.find(
      (item: { id: string }) => item.id === node.id
    )
    expect(afterRevocation.revokedAt).toBeTruthy()
    expect(
      afterRevocation.keys.filter((key: { retiredAt: string | null }) => !key.retiredAt)
    ).toHaveLength(2)
  } finally {
    await own.dispose()
    await foreign.dispose()
  }
})

test('a self-hosted host registers with a one-time credential', async ({ playwright, baseURL }) => {
  const context = new Client(
    await playwright.request.newContext({
      baseURL,
      ignoreHTTPSErrors: ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseURL!).hostname),
    })
  )
  try {
    const workspaceId = await guest(context)
    const nodesUrl = `/api/v1/workspaces/${workspaceId}/runtime-nodes`
    const opening = await context.post(nodesUrl, { data: { kind: 'remote_host' } })
    expect(opening.status()).toBe(200)
    const { challenge, exchangeCredential } = await opening.json()
    expect(exchangeCredential).toMatch(/^adea_reg_[A-Za-z0-9_-]{43}$/u)

    const signing = await keypair()
    const registration = {
      challengeId: challenge.challengeId,
      displayName: 'Home server',
      exchangeCredential,
      kind: 'remote_host',
      keys: keys(signing.publicKey, 'playwright-host-encryption'),
      platform: 'Ubuntu 26.04',
      softwareVersion: '0.20.0',
    }
    const signature = await signing.sign(
      `adea-runtime-node-pairing:v1:remote_host:${workspaceId}:${challenge.challengeId}:${challenge.nonce}`
    )
    const { node } = await pairedNode(
      await context.post(`${nodesUrl}/pair`, { data: { ...registration, signature } })
    )
    expect(node.kind).toBe('remote_host')

    // The credential is single-use, and it is bound to the challenge it was
    // issued for: neither a new challenge nor a missing credential works.
    const { challenge: nextChallenge } = await (
      await context.post(nodesUrl, { data: { kind: 'remote_host' } })
    ).json()
    expect(
      (await context.post(`${nodesUrl}/pair`, { data: { ...registration, signature } })).status()
    ).toBe(409)
    expect(
      (
        await context.post(`${nodesUrl}/pair`, {
          data: {
            ...registration,
            challengeId: nextChallenge.challengeId,
            exchangeCredential: undefined,
          },
        })
      ).status()
    ).toBe(400)
    // A spent credential cannot open a third registration either, even when the
    // proof for the new challenge is valid.
    expect(
      (
        await context.post(`${nodesUrl}/pair`, {
          data: {
            ...registration,
            challengeId: nextChallenge.challengeId,
            signature: await signing.sign(
              `adea-runtime-node-pairing:v1:remote_host:${workspaceId}:${nextChallenge.challengeId}:${nextChallenge.nonce}`
            ),
          },
        })
      ).status()
    ).toBe(409)
  } finally {
    await context.dispose()
  }
})

// A request that claims to come from the desktop shell is only served from an
// origin the shell can actually occupy, and CORS is answered for that origin.
test('runtime node pairing refuses an untrusted desktop origin', async ({
  playwright,
  baseURL,
}) => {
  const context = new Client(
    await playwright.request.newContext({
      baseURL,
      ignoreHTTPSErrors: ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseURL!).hostname),
    })
  )
  try {
    const workspaceId = await guest(context)
    const nodesUrl = `/api/v1/workspaces/${workspaceId}/runtime-nodes`
    const desktop = (origin: string) => ({ origin, 'x-adea-client': 'desktop' })
    expect(
      (
        await context.post(nodesUrl, {
          data: { kind: 'local_device' },
          headers: desktop('https://evil.example'),
        })
      ).status()
    ).toBe(403)
    expect(
      (
        await context.fetch(nodesUrl, {
          headers: desktop('https://evil.example'),
          method: 'OPTIONS',
        })
      ).status()
    ).toBe(403)

    const trusted = await context.get(nodesUrl, { headers: desktop('http://tauri.localhost') })
    expect(trusted.status()).toBe(200)
    expect(trusted.headers()['access-control-allow-origin']).toBe('http://tauri.localhost')
    expect(trusted.headers()['set-cookie']).toBeUndefined()
    const preflight = await context.fetch(nodesUrl, {
      headers: desktop('http://tauri.localhost'),
      method: 'OPTIONS',
    })
    expect(preflight.status()).toBe(204)
    expect(preflight.headers()['access-control-allow-origin']).toBe('http://tauri.localhost')
  } finally {
    await context.dispose()
  }
})
