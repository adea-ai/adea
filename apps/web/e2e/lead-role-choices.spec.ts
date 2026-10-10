import { expect, test } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer, type ViteDevServer } from 'vite'
import solid from 'vite-plugin-solid'

let server: ViteDevServer | undefined
let cacheDir = ''
let url = ''
test.beforeAll(async () => {
  const root = resolve(process.cwd(), 'apps/web')
  const harness = '/@fs' + resolve(root, 'e2e/helpers/lead-role-choices-harness-app.tsx')
  const swapHarness = '/@fs' + resolve(root, 'e2e/helpers/lead-role-client-swap-harness-app.tsx')
  // A private optimizer cache. The managed dev server owns node_modules/.vite; this instance must
  // not rewrite the dependency hashes that a running app has already requested.
  cacheDir = mkdtempSync(join(tmpdir(), 'adea-lead-roles-vite-'))
  server = await createServer({
    configFile: false,
    root,
    cacheDir,
    // This module-only fixture serves no public assets. Preserve unrelated sync copies.
    publicDir: false,
    // Serve this ESM fixture graph directly; do not scan unrelated application HTML/assets.
    optimizeDeps: { noDiscovery: true, include: [] },
    logLevel: 'error',
    plugins: [
      solid(),
      {
        name: 'lead-payer-mounted-fixture',
        configureServer(fixture) {
          for (const [path, script] of [
            ['/__lead-roles', harness],
            ['/__lead-client-swap', swapHarness],
          ])
            fixture.middlewares.use(path, (_request, response) => {
              response.setHeader('Content-Type', 'text/html')
              response.end(
                `<html><body><div id="harness-root"></div><script type="module" src="${script}"></script></body></html>`
              )
            })
        },
      },
    ],
    resolve: { dedupe: ['solid-js'], conditions: ['solid', 'browser', 'development'] },
    // The fixture modules are static; no HMR or repository-wide asset watcher is needed.
    server: { watch: null, host: '127.0.0.1', port: 0, strictPort: true },
  })
  await server.listen()
  const address = server.httpServer?.address()
  if (!address || typeof address === 'string') throw new Error('Lead fixture did not bind')
  url = `http://127.0.0.1:${address.port}/__lead-roles`
})
test.afterAll(async () => {
  await server?.close()
  rmSync(cacheDir, { recursive: true, force: true })
})

// Scripted HTTP tests real chooser/composer/client transport, independently of CP execution.
test('distinct role choices reach canonical admission and lost-ACK retry keeps the same refs', async ({
  page,
}) => {
  await page.goto(url)
  await page
    .getByLabel('Lead model choice', { exact: true })
    .getByRole('button', { name: 'scripted / model-a (account-a)', exact: true })
    .click()
  await page
    .getByLabel('Delegated agent model choice', { exact: true })
    .getByRole('button', { name: 'scripted / model-b (account-b)', exact: true })
    .click()
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByLabel('Saved choices')).toHaveText(
    JSON.stringify({
      lead: { selectionRef: `msel_${'a'.repeat(32)}`, selectionRevision: 1 },
      child: { selectionRef: `msel_${'b'.repeat(32)}`, selectionRevision: 1 },
    })
  )
  await expect(page.getByLabel('Message posts')).toHaveText('1')
  await expect(page.getByLabel('Selection resolutions')).toHaveText('2')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByLabel('Message posts')).toHaveText('2')
  await expect(page.getByLabel('Selection resolutions')).toHaveText('2')
  await expect(page.getByRole('textbox')).toHaveValue('Unsent lead question')
})
test('revoked choice blocks before message admission and retains the independent draft', async ({
  page,
}) => {
  await page.goto(url)
  await page
    .getByLabel('Lead model choice', { exact: true })
    .getByRole('button', { name: 'scripted / model-a (account-a)', exact: true })
    .click()
  await page.getByRole('button', { name: 'Revoke selected models', exact: true }).click()
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(
    page.getByText(
      'Message not sent. Your draft is still here; retry when the connection recovers.'
    )
  ).toBeVisible()
  await expect(page.getByLabel('Message posts')).toHaveText('0')
  await expect(page.getByLabel('Selection resolutions')).toHaveText('0')
  await expect(page.getByRole('textbox')).toHaveValue('Unsent lead question')
})

test('child-only override stays separate and audience invalidation resets choices without losing draft', async ({
  page,
}) => {
  await page.goto(url)
  await page
    .getByLabel('Delegated agent model choice', { exact: true })
    .getByRole('button', { name: 'scripted / model-b (account-b)', exact: true })
    .click()
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByLabel('Saved choices')).toHaveText(
    JSON.stringify({ child: { selectionRef: `msel_${'b'.repeat(32)}`, selectionRevision: 1 } })
  )
  await expect(page.getByLabel('Selection resolutions')).toHaveText('1')
  await page.getByRole('button', { name: 'Invalidate audience', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Use lead workspace default', exact: true })
  ).toHaveAttribute('aria-pressed', 'true')
  await expect(
    page.getByRole('button', { name: 'Use child workspace default', exact: true })
  ).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('textbox')).toHaveValue('Unsent lead question')
})

test('explicit lead choice shows account, auth and recorded payer before the start request', async ({
  page,
}) => {
  await page.goto(url)
  await page
    .getByLabel('Lead model choice', { exact: true })
    .getByRole('button', { name: 'scripted / model-a (account-a)', exact: true })
    .click()
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByLabel('Saved choices')).toContainText(`msel_${'a'.repeat(32)}`)
  await page.getByRole('button', { name: 'Review model and payer', exact: true }).click()
  const disclosure = page.getByLabel('Current model and payer')
  await expect(disclosure).toContainText('Provider: scripted · Model: model-a')
  await expect(disclosure).toContainText('Account: account-a · Authentication: api_key')
  await expect(disclosure).toContainText(
    'Funding: byo_api · Payer: Recorded workspace payer (workspace_account, payer:workspace)'
  )
  await expect(page.getByLabel('Lead starts')).toHaveText('0')
  await expect(page.getByRole('button', { name: 'Start lead turn', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Confirm this model and payer', exact: true }).click()
  await page.getByRole('button', { name: 'Start lead turn', exact: true }).click()
  await expect(page.getByLabel('Lead starts')).toHaveText('1')
  await expect(page.getByLabel('Started selection ref')).toHaveText(`msel_${'a'.repeat(32)}`)
})

test('client replacement refetches choices and a late old-client response cannot admit a message', async ({
  page,
}) => {
  await page.goto(url.replace('/__lead-roles', '/__lead-client-swap'))
  await expect(page.getByText('Existing history')).toBeVisible()
  await expect(page.getByLabel('Old lists')).not.toHaveText('0')
  await page
    .getByLabel('Lead model choice', { exact: true })
    .getByRole('button', { name: 'scripted / model-old (account-old)', exact: true })
    .click()
  await expect(
    page
      .getByLabel('Lead model choice', { exact: true })
      .getByRole('button', { name: 'scripted / model-old (account-old)', exact: true })
  ).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByLabel('Old resolves')).toHaveText('1')
  await expect(page.locator('[data-message-id="optimistic-message"]')).toBeVisible()
  await page.getByRole('button', { name: 'Replace signed client', exact: true }).click()
  await expect(page.getByLabel('Active client')).toHaveText('replacement')
  await expect(page.locator('[data-message-id="optimistic-message"]')).toHaveCount(0)
  await expect(
    page.getByLabel('Lead model choice', { exact: true }).getByRole('button', {
      name: 'scripted / model-replacement (account-replacement)',
      exact: true,
    })
  ).toBeVisible()
  await expect(page.getByLabel('Replacement lists')).not.toHaveText('0')
  await expect(page.getByText('Requested: model-old')).toHaveCount(0)
  await page.getByRole('button', { name: 'Release old response', exact: true }).click()
  await expect(page.getByLabel('Message post clients')).toHaveText('')
  await expect(page.getByRole('textbox')).toHaveValue('Retained draft')
  await page
    .getByLabel('Lead model choice', { exact: true })
    .getByRole('button', {
      name: 'scripted / model-replacement (account-replacement)',
      exact: true,
    })
    .click()
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByLabel('Replacement resolves')).toHaveText('1')
  await expect(page.getByLabel('Message post clients')).toHaveText('replacement')
})
