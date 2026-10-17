import 'server-only'

import { createDatabase } from '@adea-ai/db'

import {
  resolveDatabaseConnectionString,
  shouldRegisterDatabaseShutdownHooks,
} from './database-connection'
import { registerRequestCleanup, requestScopedValue } from './request-scope'

let shutdownRegistered = false

function registerDatabaseShutdown() {
  if (shutdownRegistered || !shouldRegisterDatabaseShutdownHooks()) return
  shutdownRegistered = true

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      process.exit(signal === 'SIGINT' ? 130 : 143)
    })
  }
}

const requestDatabaseKey = Symbol('applicationDatabase')

function openApplicationDatabase() {
  const connection = createDatabase(resolveDatabaseConnectionString())
  registerDatabaseShutdown()
  registerRequestCleanup(() => connection.close().catch(() => undefined))
  return connection.db
}

export function applicationDatabase() {
  // One short-lived client per REQUEST, closed with the request scope. Hyperdrive
  // pools at the origin, so worker-side reuse across requests buys nothing — and
  // reused pooled sessions go stale across requests, which hangs requests until
  // the runtime kills them. Reuse inside one request is the opposite: the
  // principal lookup, the authorization check and the query each used to open
  // their own client (a connection, an authentication handshake and an ORM
  // schema build apiece), which is most of the CPU a free-plan Worker has per
  // invocation. The client lives in the request scope, so no other request can
  // ever reach it, and every read still hits the database fresh. Outside a
  // scope (tests, scripts) each call opens its own client as before.
  return requestScopedValue(requestDatabaseKey, openApplicationDatabase)
}
