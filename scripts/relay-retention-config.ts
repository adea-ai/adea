import { readDatabaseUrl, type DatabaseEnvironment } from '../packages/db/src/config'

export type RelayRetentionOptions = {
  host: string
  port: number
  database: string
  workspaceId: string
  limit: number
  apply: boolean
}

export class RelayRetentionOperatorError extends Error {
  constructor(readonly code: 'invalid_arguments' | 'invalid_database' | 'wrong_target') {
    super(code)
    this.name = 'RelayRetentionOperatorError'
  }
}

function refuseArguments(): never {
  throw new RelayRetentionOperatorError('invalid_arguments')
}

export function parseRelayRetentionArguments(args: string[]): RelayRetentionOptions {
  const fields = new Set(['--host', '--port', '--database', '--workspace', '--limit'])
  const values = new Map<string, string>()
  let apply = false
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!
    if (flag === '--apply') {
      if (apply) refuseArguments()
      apply = true
    } else {
      const value = args[++index]
      if (!fields.has(flag) || values.has(flag) || !value || value.startsWith('--'))
        refuseArguments()
      values.set(flag, value!)
    }
  }
  if (values.size !== fields.size) refuseArguments()
  const host = values.get('--host')!
  const database = values.get('--database')!
  const workspaceId = values.get('--workspace')!
  const portText = values.get('--port')!
  const limitText = values.get('--limit')!
  const port = Number(portText)
  const limit = Number(limitText)
  if (
    !/^(?:[a-z0-9][a-z0-9.-]{0,252}|\[[a-f0-9:]+\])$/.test(host) ||
    !/^[A-Za-z_][A-Za-z0-9_-]{0,62}$/.test(database) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      workspaceId
    ) ||
    !/^[1-9][0-9]{0,4}$/.test(portText) ||
    port > 65535 ||
    !/^[1-9][0-9]{0,3}$/.test(limitText) ||
    limit > 1000
  )
    refuseArguments()
  return { host, port, database, workspaceId, limit, apply }
}

/** Validate intent before constructing a client; never return a diagnostic containing the DSN. */
export function relayRetentionDatabaseUrl(
  options: RelayRetentionOptions,
  environment: DatabaseEnvironment = process.env
): string {
  let value: string
  let url: URL
  let database: string
  try {
    value = readDatabaseUrl(environment, 'DATABASE_URL_UNPOOLED')
    url = new URL(value)
    database = decodeURIComponent(url.pathname.slice(1))
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    const modes = url.searchParams.getAll('sslmode')
    if (
      !decodeURIComponent(url.username).endsWith('_app') ||
      url.hash ||
      [...url.searchParams.keys()].some((key) => key !== 'sslmode') ||
      modes.length > 1 ||
      (modes.length && !['disable', 'require', 'verify-ca', 'verify-full'].includes(modes[0]!)) ||
      (!local && !['require', 'verify-ca', 'verify-full'].includes(modes[0] ?? '')) ||
      url.hostname.includes('-pooler.')
    )
      throw new Error('invalid')
  } catch {
    throw new RelayRetentionOperatorError('invalid_database')
  }
  if (
    url.hostname !== options.host ||
    Number(url.port || 5432) !== options.port ||
    database !== options.database
  )
    throw new RelayRetentionOperatorError('wrong_target')
  return value
}
