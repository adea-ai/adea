import { createHash, X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { readDatabaseUrl, isLoopbackDatabaseHost, type DatabaseEnvironment } from './config'

// Public CA obtained through authenticated Railway SSH, verified through the existing proxy.
export const PRODUCTION_MIGRATION_TARGET = Object.freeze({
  host: 'altaria.proxy.rlwy.net',
  port: 44407,
  database: 'railway',
  role: 'adea_prod_migration',
  servername: 'postgres.railway.internal',
  caSha256: '3022dc74d0ca3f397259f884ae46f49ce41a51b6208a71a6a30d7fcf142f9c90',
})

export function migrationConnection(environment: DatabaseEnvironment = process.env) {
  const connectionUrl = readDatabaseUrl(environment, 'DATABASE_MIGRATION_URL')
  const url = new URL(connectionUrl)
  if (isLoopbackDatabaseHost(url.hostname)) return { connectionUrl, options: {} }
  const target = PRODUCTION_MIGRATION_TARGET
  if (
    url.hostname !== target.host ||
    Number(url.port || 5432) !== target.port ||
    decodeURIComponent(url.pathname.slice(1)) !== target.database ||
    decodeURIComponent(url.username) !== target.role ||
    url.hash ||
    url.searchParams.get('sslmode') !== 'verify-full' ||
    [...url.searchParams.keys()].some((key) => key !== 'sslmode')
  ) {
    throw new Error('Migration target does not match the reviewed Railway production identity')
  }
  const ca = readFileSync(
    new URL('../../../.railway/production-postgres-ca.crt', import.meta.url),
    'utf8'
  )
  if (createHash('sha256').update(new X509Certificate(ca).raw).digest('hex') !== target.caSha256) {
    throw new Error('Migration CA does not match the reviewed Railway production trust anchor')
  }
  return {
    connectionUrl,
    options: { tls: { rejectUnauthorized: true as const, servername: target.servername, ca } },
  }
}
