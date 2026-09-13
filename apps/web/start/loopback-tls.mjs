import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// The local Worker checks run behind `wrangler dev --local-protocol https`
// because production-built sessions use `Secure` cookies. Instead of turning
// certificate verification off, each run mints an ephemeral certificate that
// only carries loopback names, hands it to wrangler, and trusts that exact
// certificate for its loopback requests. Every other origin keeps the default
// trust store, and the certificate cannot vouch for a non-loopback host.
export function createLoopbackCertificate(directory) {
  const keyPath = resolve(directory, 'loopback-key.pem')
  const certPath = resolve(directory, 'loopback-cert.pem')
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-sha256',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '2',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1,DNS:localhost',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    )
  } catch (error) {
    throw new Error(
      `openssl could not mint the loopback certificate: ${error.stderr?.toString() ?? error.message}`,
      { cause: error }
    )
  }
  return { keyPath, certPath, certificate: readFileSync(certPath) }
}
