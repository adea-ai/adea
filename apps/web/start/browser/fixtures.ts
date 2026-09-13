import { test as base } from '@playwright/test'

/**
 * Transport hardening for the isolated lane.
 *
 * The suite runs against `wrangler dev --local-protocol https` because
 * production sessions use `Secure` cookies. That local TLS listener
 * occasionally drops a subresource request of a fresh browser context: the
 * Worker answers 200 (the worker log shows the response) while Chromium
 * reports the request as failed, leaving the page unstyled or a deferred chunk
 * missing. `start/browser/request-client.ts` already retries exactly this loss
 * for API calls; this fixture applies the same policy to the document's assets.
 *
 * Only transport failures are retried. Every response the Worker actually
 * produces — including 4xx and the route handlers' own 5xx — is fulfilled
 * untouched on the first attempt, so no assertion or application failure is
 * hidden by this retry. A request still in flight when the test ends is
 * aborted rather than reported as a test failure.
 */
const MAX_ATTEMPTS = 4

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.route('**/start-assets/*', async (route) => {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        try {
          const response = await route.fetch()
          if (response.status() < 500) {
            await route.fulfill({ response })
            return
          }
        } catch {
          // Transport loss (or a context that closed mid-flight): retry, then
          // fall through to the abort below.
        }
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
      }
      await route.abort().catch(() => undefined)
    })
    await use(page)
  },
})

export { expect } from '@playwright/test'
