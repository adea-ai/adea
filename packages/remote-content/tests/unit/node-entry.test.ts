import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'

test('compiled Node ESM entry preserves command APIs and a request-bound result round trip', () => {
  const entry = new URL('../../dist/index.js', import.meta.url).href
  const report = JSON.parse(
    execFileSync(
      'node',
      [
        '--input-type=module',
        '--eval',
        `
    const library = await import(${JSON.stringify(entry)});
    const now = Date.now();
    const scope = {
      workspaceId: '00000000-0000-4000-8000-000000000001',
      runtimeNodeId: '00000000-0000-4000-8000-000000000002',
      requestId: '00000000-0000-4000-8000-000000000003',
    };
    const receiver = await library.createRemoteResultReceiver({ ...scope,
      issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60000).toISOString(), now });
    const envelope = await library.sealRemoteResult({ recipient: receiver.recipient, expectedScope: scope,
      plaintext: new TextEncoder().encode('compiled package fixture'), now });
    const replayGuard = library.createRemoteContentReplayGuard({ ...scope, ledger: { claim: async () => true }, now: () => now });
    const plaintext = await library.openRemoteResult({ receiver, envelope, replayGuard, now });
    console.log(JSON.stringify({ commandApi: typeof library.openRemoteContent,
      result: new TextDecoder().decode(plaintext), privateKeySerialized: Object.hasOwn(JSON.parse(JSON.stringify(receiver)), 'privateKey') }));
  `,
      ],
      { encoding: 'utf8' }
    )
  )
  expect(report).toEqual({
    commandApi: 'function',
    result: 'compiled package fixture',
    privateKeySerialized: false,
  })
})
