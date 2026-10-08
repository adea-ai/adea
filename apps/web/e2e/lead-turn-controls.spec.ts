import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'
import { createServer, type ViteDevServer } from 'vite'
import solid from 'vite-plugin-solid'

let server: ViteDevServer | undefined
let url = ''
test.beforeAll(async () => {
  const root = resolve(process.cwd(), 'apps/web')
  const harness = '/@fs' + resolve(root, 'e2e/helpers/lead-turn-controls-harness-app.tsx')
  server = await createServer({
    configFile: false,
    root,
    logLevel: 'error',
    plugins: [
      solid(),
      {
        name: 'lead-turn-mounted-fixture',
        configureServer(fixture) {
          fixture.middlewares.use('/__lead-controls', (_request, response) => {
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
  if (!address || typeof address === 'string') throw new Error('Lead fixture did not bind')
  url = `http://127.0.0.1:${address.port}/__lead-controls`
})
test.afterAll(async () => {
  await server?.close()
})

test('cancellation appears after a running observation and follows busy and terminal updates', async ({
  page,
}) => {
  await page.goto(url)
  const surface = page.getByRole('region', { name: 'Workspace lead turn' })
  const cancel = page.getByRole('button', { name: 'Request cancellation', exact: true })
  await expect(surface).toBeVisible()
  await expect(cancel).toHaveCount(0)
  await page.getByRole('button', { name: 'Resolve running observation' }).click()
  await expect(surface.getByText('Running', { exact: true })).toBeVisible()
  await expect(cancel).toBeVisible()
  await cancel.click()
  await expect(page.getByLabel('Cancellation requests')).toHaveText('1')
  await expect(cancel).toHaveCount(0)
  await page.getByRole('button', { name: 'Acknowledge cancellation request' }).click()
  await expect(surface.getByText('Cancellation requested', { exact: true })).toBeVisible()
  await expect(cancel).toBeVisible()
  await page.getByRole('button', { name: 'Observe completion next' }).click()
  await page.getByRole('button', { name: 'Refresh lead status' }).click()
  await expect(surface.getByText('Completed', { exact: true })).toBeVisible()
  await expect(cancel).toHaveCount(0)
  await expect(page.getByLabel('Cancellation requests')).toHaveText('1')
})
