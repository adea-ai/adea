import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { sealRemoteResult, type RemoteResultRecipient } from '../../../packages/remote-content/src'

const modulePath = fileURLToPath(
  new URL('../../../packages/remote-content/src/index.ts', import.meta.url)
)
const scope = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  runtimeNodeId: '00000000-0000-4000-8000-000000000002',
  requestId: '00000000-0000-4000-8000-000000000003',
}

for (const host of ['node', 'bun'] as const) {
  test(`browser return key decrypts the ${host} host result without exposing its private key`, async ({
    page,
  }) => {
    // Bundle the production module for a real browser, with no app/SDK mock or
    // duplicated crypto implementation. Every request stays inside this isolated
    // context; the secure synthetic origin supplies browser WebCrypto.
    const source = execFileSync('bun', ['build', modulePath, '--target=browser', '--format=esm'], {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    })
    await page.route('https://crypto.adea.invalid/**', async (route) => {
      await route.fulfill({
        contentType: route.request().url().endsWith('module.js') ? 'text/javascript' : 'text/html',
        body: route.request().url().endsWith('module.js')
          ? source
          : '<!doctype html><title>Isolated return crypto fixture</title>',
      })
    })
    await page.goto('https://crypto.adea.invalid/')
    const now = Date.now()
    const recipient = (await page.evaluate(
      async ({ scope: fixtureScope, now: fixtureNow }) => {
        const module = await import(`${window.location.origin}/module.js`)
        const receiver = await module.createRemoteResultReceiver({
          ...fixtureScope,
          issuedAt: new Date(fixtureNow).toISOString(),
          expiresAt: new Date(fixtureNow + 60_000).toISOString(),
          now: fixtureNow,
        })
        Object.assign(window, { resultCrypto: { module, receiver } })
        return JSON.parse(JSON.stringify(receiver)).recipient
      },
      { scope, now }
    )) as RemoteResultRecipient
    const plaintext = 'host result confidential canary'
    const hostInput = {
      recipient,
      expectedScope: scope,
      plaintext,
      now,
    }
    const envelope =
      host === 'node'
        ? await sealRemoteResult({ ...hostInput, plaintext: new TextEncoder().encode(plaintext) })
        : JSON.parse(
            execFileSync(
              'bun',
              [
                '--eval',
                `
        import { sealRemoteResult } from ${JSON.stringify(modulePath)};
        const input = JSON.parse(await Bun.stdin.text());
        const sealed = await sealRemoteResult({ ...input, plaintext: new TextEncoder().encode(input.plaintext) });
        console.log(JSON.stringify(sealed));
      `,
              ],
              { input: JSON.stringify(hostInput), encoding: 'utf8' }
            )
          )
    expect(JSON.stringify(recipient)).not.toContain('privateKey')
    expect(JSON.stringify(envelope)).not.toContain(plaintext)
    const result = await page.evaluate(
      async ({ envelope: fixtureEnvelope, scope: fixtureScope, now: fixtureNow }) => {
        const { module, receiver } = (
          window as unknown as {
            resultCrypto: {
              module: typeof import('../../../packages/remote-content/src')
              receiver: import('../../../packages/remote-content/src').RemoteResultReceiver
            }
          }
        ).resultCrypto
        const replayGuard = module.createRemoteContentReplayGuard({
          ...fixtureScope,
          ledger: { claim: async () => true },
          now: () => fixtureNow,
        })
        const bytes = await module.openRemoteResult({
          receiver,
          envelope: fixtureEnvelope,
          replayGuard,
          now: fixtureNow,
        })
        let replayCode = ''
        try {
          await module.openRemoteResult({
            receiver,
            envelope: fixtureEnvelope,
            replayGuard,
            now: fixtureNow,
          })
        } catch (error) {
          replayCode = (error as { code: string }).code
        }
        return { plaintext: new TextDecoder().decode(bytes), replayCode }
      },
      { envelope, scope, now }
    )
    expect(result).toEqual({ plaintext, replayCode: 'return_key_unavailable' })
  })
}
