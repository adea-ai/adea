import type { APIRequestContext, APIResponse } from '@playwright/test'

/**
 * The isolated lane serves the worker through workerd's local TLS listener, and
 * a pooled connection the listener has already closed comes back as a miniflare
 * 500 whose body is a transport error rather than an app response. Request-heavy
 * specs hit this, so this client retries that one case; every other outcome,
 * including a 500 from the route handlers, is returned untouched.
 */
export class Client {
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
