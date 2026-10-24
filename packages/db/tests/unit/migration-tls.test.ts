import { expect, test } from 'bun:test'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSecureContext, TLSSocket } from 'node:tls'

test('migration driver verifies the CA and peer identity through PostgreSQL STARTTLS', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'adea-migration-tls-'))
  const certificate = (name: string) => {
    const key = join(directory, `${name}.key`)
    const cert = join(directory, `${name}.crt`)
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        `/CN=${name}.invalid`,
        '-addext',
        `subjectAltName=DNS:${name}.invalid`,
        '-keyout',
        key,
        '-out',
        cert,
      ],
      { stdio: 'ignore' }
    )
    return { key: readFileSync(key), cert: readFileSync(cert, 'utf8') }
  }
  const identity = certificate('synthetic-peer')
  const other = certificate('other-peer')
  const context = createSecureContext(identity)
  const sockets = new Set<import('node:net').Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    socket.once('data', (request) => {
      expect(request.readInt32BE(4)).toBe(80877103)
      socket.write('S')
      const secure = new TLSSocket(socket, { isServer: true, secureContext: context })
      secure.on('error', () => {})
      secure.once('data', () => {
        // A synthetic PostgreSQL rejection proves the verified TLS channel reached startup.
        const fields = Buffer.from('SFATAL\0CXX999\0Msynthetic startup reached\0\0')
        const length = Buffer.alloc(4)
        length.writeInt32BE(fields.length + 4)
        secure.end(Buffer.concat([Buffer.from('E'), length, fields]))
      })
    })
  })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as import('node:net').AddressInfo).port
    for (const scenario of [
      { ca: identity.cert, servername: 'synthetic-peer.invalid', expected: 'XX999' },
      {
        ca: identity.cert,
        servername: 'wrong-peer.invalid',
        expected: 'ERR_TLS_CERT_ALTNAME_INVALID',
      },
      {
        ca: other.cert,
        servername: 'synthetic-peer.invalid',
        expected: 'DEPTH_ZERO_SELF_SIGNED_CERT',
      },
    ]) {
      const script = `
        import {createDatabase} from '${new URL('../../src/connection.ts', import.meta.url).href}';
        const connection=createDatabase('postgresql://fixture:synthetic@127.0.0.1:${port}/fixture?sslmode=verify-full', {connectTimeoutSeconds:2, tls:${JSON.stringify({ rejectUnauthorized: true, ca: scenario.ca, servername: scenario.servername })}});
        try { await connection.client\`select 1\`; process.exitCode=1; }
        catch (error) { console.log(JSON.stringify({code:error.code})); }
        finally { await connection.close(); }
      `
      const result = await promisify(execFile)(process.execPath, ['--eval', script], {
        timeout: 8000,
      })
      expect(JSON.parse(result.stdout.trim())).toEqual({ code: scenario.expected })
    }
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(directory, { recursive: true, force: true })
  }
}, 15000)
