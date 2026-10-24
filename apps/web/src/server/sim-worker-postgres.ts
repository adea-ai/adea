import {
  createDatabase,
  createSimAllowlistLookup,
  createSimRedemptionStore,
  createSimSessionLookup,
} from '@adea-ai/db'

import type { SimWorkerStores } from './sim-worker-composition'

/**
 * Opens the durable Sim stores over PostgreSQL for one request.
 *
 * The connection string belongs to the Sim host database role, which needs `SELECT` on
 * `app.sim_workspace_allowlist`, `SELECT` and `UPDATE` on `app.sim_launch_codes`, and `SELECT` and
 * `INSERT` on `app.sim_sessions`, and nothing else. This module cannot widen that: it only builds
 * the three merged store adapters over the connection it is given, none of which reads
 * `app.workspaces` or issues a launch code.
 *
 * The connection is opened per request and closed by `close`, because a Worker cannot reuse an I/O
 * object across requests. It connects lazily, so opening the stores performs no network I/O by
 * itself.
 */
export function openSimPostgresStores(connectionString: string): SimWorkerStores {
  const connection = createDatabase(connectionString, { maxConnections: 2 })
  return {
    store: createSimRedemptionStore(connection.db) as SimWorkerStores['store'],
    sessions: createSimSessionLookup(connection.db),
    allowlist: createSimAllowlistLookup(connection.db),
    close: () => connection.close(),
  }
}
