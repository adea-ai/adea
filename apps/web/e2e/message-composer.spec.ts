import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'
import { createServer, type ViteDevServer } from 'vite'
import solid from 'vite-plugin-solid'

let server: ViteDevServer | undefined
let url = ''
test.beforeAll(async () => {
  const root = resolve(process.cwd(), 'apps/web')
  const harness = '/@fs' + resolve(root, 'e2e/helpers/message-composer-harness-app.tsx')
  server = await createServer({
    configFile: false,
    root,
    logLevel: 'error',
    plugins: [
      solid(),
      {
        name: 'message-composer-mounted-fixture',
        configureServer(fixture) {
          fixture.middlewares.use('/__message-composer', (_request, response) => {
            response.setHeader('Content-Type', 'text/html')
            response.end(
              `<html><body><div id="harness-root"></div><script type="module" src="${harness}"></script></body></html>`
            )
          })
        },
      },
    ],
    resolve: { dedupe: ['solid-js'], conditions: ['solid', 'browser', 'development'] },
    server: { host: '127.0.0.1', port: 0, strictPort: true },
  })
  await server.listen()
  const address = server.httpServer?.address()
  if (!address || typeof address === 'string') throw new Error('Composer fixture did not bind')
  url = `http://127.0.0.1:${address.port}/__message-composer`
})
test.afterAll(async () => {
  await server?.close()
})

test('failed send keeps the draft and unchanged retry identity, then confirmed success clears it', async ({
  page,
}) => {
  await page.goto(url)
  const composer = page.getByRole('textbox', { name: 'Message', exact: true })
  await composer.fill('Keep this draft')
  await composer.press('Enter')
  await expect(composer).toBeDisabled()
  await page.getByRole('button', { name: 'Reject send', exact: true }).click()
  await expect(
    page.getByText(
      'Message not sent. Your draft is still here; retry when the connection recovers.'
    )
  ).toBeVisible()
  await expect(composer).toHaveValue('Keep this draft')
  await composer.press('Enter')
  const submissions = JSON.parse(await page.getByLabel('Submissions').innerText()) as Array<{
    idempotencyKey: string
    bodyText: string
  }>
  expect(submissions).toHaveLength(2)
  expect(submissions[0]?.bodyText).toBe('Keep this draft')
  expect(submissions[1]?.idempotencyKey).toBe(submissions[0]?.idempotencyKey)
  await page.getByRole('button', { name: 'Resolve send', exact: true }).click()
  await expect(composer).toHaveValue('')
  await expect(composer).toBeEnabled()
})

test('disposed composer cannot clear another topic or overwrite its retained draft', async ({
  page,
}) => {
  await page.goto(url)
  const composer = page.getByRole('textbox', { name: 'Message', exact: true })
  await composer.fill('Pending first draft')
  await composer.press('Enter')
  await expect(composer).toBeDisabled()
  await page.getByRole('button', { name: 'Switch topic', exact: true }).click()
  await expect(composer).toHaveValue('Independent second draft')
  await page.getByRole('button', { name: 'Resolve send', exact: true }).click()
  await expect(composer).toHaveValue('Independent second draft')
  await expect(page.getByLabel('First draft')).toHaveText('Pending first draft')
  await page.getByRole('button', { name: 'Switch topic', exact: true }).click()
  await expect(composer).toHaveValue('Pending first draft')
})
