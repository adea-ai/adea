// The browser half of the channel, injected into the app's own window only.
//
// The observable bridge contract is `window.__adeaDesktop.invoke` /
// `.listen` / `.devExecute` / `.streamAttachProof` (see
// apps/web/src/lib/desktop-bridge.ts); underneath, the script performs
// `dev.runtime.handshake.v1` with the single-use launch bootstrap, keeps the
// channel secret in a closure that never touches `window`, and signs every
// request with an HMAC over the exact bytes the shell's authority verifies.
// The secret is never persisted, logged, or returned to React state.
import { LEGACY_INVOKE_PROOF_CONTEXT } from './authority'

/**
 * Builds the bridge script. `contextSeparator` must equal the separator the
 * authority's `legacyProofMessage` joins with (ASCII 0x1f) — the two sides
 * sign and verify identical strings.
 */
export function createBridgeScript(options: {
  contextSeparator: string
  shellOrigin: string
}): string {
  const context = JSON.stringify(LEGACY_INVOKE_PROOF_CONTEXT)
  const separator = JSON.stringify(options.contextSeparator)
  return `(function () {
  'use strict'
  var PROOF_CONTEXT = ${context}
  var PROOF_SEPARATOR = ${separator}
  var SHELL_ORIGIN = ${JSON.stringify(options.shellOrigin)}
  var BOOTSTRAP = window.__ADEA_LAUNCH_BOOTSTRAP__
  var channel = null

  function toBase64Url(bytes) {
    var binary = ''
    for (var i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
    return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '')
  }

  function fromBase64Url(text) {
    var padded = text.replace(/-/g, '+').replace(/_/g, '/')
    while (padded.length % 4 !== 0) padded += '='
    var binary = atob(padded)
    var bytes = new Uint8Array(binary.length)
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return bytes
  }

  function randomNonce() {
    var bytes = new Uint8Array(24)
    crypto.getRandomValues(bytes)
    return toBase64Url(bytes)
  }

  function canonical(value) {
    if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value)
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
    var keys = Object.keys(value).sort()
    return '{' + keys.map(function (key) { return JSON.stringify(key) + ':' + canonical(value[key]) }).join(',') + '}'
  }

  function devProofMessage(open, command) {
    return [
      'adea-dev-command-proof:v1', open.channelId, open.clientCredentialId,
      command.operation, command.requestId, command.nonce,
      canonical(command.capabilities.slice().sort()), canonical(command.scope),
      command.resource ? canonical(command.resource) : '', command.issuedAt,
      command.expiresAt, command.idempotencyKey || '', canonical(command.body)
    ].join(String.fromCharCode(31))
  }

  function hmac(secret, message) {
    return crypto.subtle
      .importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      .then(function (key) {
        return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
      })
      .then(function (signature) {
        return toBase64Url(new Uint8Array(signature))
      })
  }

  function sha256Hex(text) {
    return crypto.subtle
      .digest('SHA-256', new TextEncoder().encode(text))
      .then(function (digest) {
        var hex = ''
        new Uint8Array(digest).forEach(function (byte) {
          hex += byte.toString(16).padStart(2, '0')
        })
        return hex
      })
  }

  function ensureChannel() {
    if (!channel) {
      channel = fetch(SHELL_ORIGIN + '/__adea/handshake', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: SHELL_ORIGIN },
        body: JSON.stringify({
          schemaVersion: 1,
          method: 'dev.runtime.handshake.v1',
          requestId: crypto.randomUUID(),
          bootstrap: BOOTSTRAP,
          supportedProtocolVersions: ['1'],
          nonce: randomNonce(),
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 30000).toISOString(),
        }),
      })
        .then(function (response) {
          return response.json()
        })
        .then(function (reply) {
          if (!reply.ok) {
            channel = null
            throw new Error(
              'channel handshake refused: ' + ((reply.error && reply.error.code) || 'unknown')
            )
          }
          return {
            channelId: reply.channelId,
            clientCredentialId: reply.clientCredentialId,
            // The secret lives only in this closure.
            secret: fromBase64Url(reply.clientSecret),
          }
        })
    }
    return channel
  }

  function signedRequest(path, bodyObject) {
    return ensureChannel().then(function (open) {
      var body = JSON.stringify(bodyObject)
      var nonce = randomNonce()
      var timestamp = String(Date.now())
      return sha256Hex(body)
        .then(function (bodySha256) {
          return hmac(
            open.secret,
            [PROOF_CONTEXT, open.channelId, open.clientCredentialId, nonce, timestamp, bodySha256]
              .join(PROOF_SEPARATOR)
          )
        })
        .then(function (proof) {
          return {
            open: open,
            responsePromise: fetch(SHELL_ORIGIN + path, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-adea-channel': open.channelId,
                'x-adea-credential': open.clientCredentialId,
                'x-adea-nonce': nonce,
                'x-adea-timestamp': timestamp,
                'x-adea-proof': proof,
                origin: SHELL_ORIGIN,
              },
              body: body,
            }),
          }
        })
    })
  }

  function executeDev(command) {
    return ensureChannel().then(function (open) {
      return hmac(open.secret, devProofMessage(open, command)).then(function (proof) {
        return signedRequest('/__adea/invoke', {
          cmd: 'dev.runtime.execute.v1',
          args: { command: command, proof: proof }
        }).then(function (signed) {
          return signed.responsePromise.then(function (response) { return response.json() })
        })
      })
    })
  }

  function invoke(cmd, args) {
    return signedRequest('/__adea/invoke', { cmd: cmd, args: args === undefined ? null : args })
      .then(function (signed) {
        return signed.responsePromise.then(function (response) {
          return response
            .json()
            .catch(function () {
              return {}
            })
            .then(function (result) {
              if (!response.ok) {
                throw new Error(result.error || 'desktop command refused')
              }
              return result
            })
        })
      })
      .then(function (result) {
        if (!result.ok) throw new Error(result.error || 'desktop command failed')
        return result.value
      })
  }

  // Bulk-stream attach signing (#399 residue): the renderer's stream
  // transport attaches a minted file-bytes-v1 grant through the shell's
  // stream relay on THIS page channel. Only the proof leaves this closure —
  // the secret never does, and the proof is grant-scoped, single-use, and
  // expired by the authority within 60 seconds. The field framing must
  // byte-match the host's devStreamAttachProofMessage (0x1f-joined).
  function streamAttachProof(request) {
    return ensureChannel().then(function (open) {
      var message = [
        'adea-dev-stream-attach-proof:v1',
        open.channelId,
        String(request.grantId || ''),
        String(request.requestId || ''),
        String(request.nonce || ''),
        String(request.fromSequence || '')
      ].join(String.fromCharCode(31))
      return hmac(open.secret, message).then(function (proof) {
        return {
          channelId: open.channelId,
          clientCredentialId: open.clientCredentialId,
          proof: proof
        }
      })
    })
  }

  function listen(event, handler) {
    return signedRequest('/__adea/events-token', { event: event })
      .then(function (signed) {
        return signed.responsePromise.then(function (response) {
          return response.json().then(function (minted) {
            if (!response.ok) throw new Error('event channel refused')
            return { open: signed.open, minted: minted }
          })
        })
      })
      .then(function (opened) {
        var query =
          'event=' +
          encodeURIComponent(event) +
          '&channel=' +
          encodeURIComponent(opened.open.channelId) +
          '&credential=' +
          encodeURIComponent(opened.open.clientCredentialId) +
          '&token=' +
          encodeURIComponent(opened.minted.token)
        var source = new EventSource(SHELL_ORIGIN + '/__adea/events?' + query)
        source.onmessage = function (message) {
          try {
            handler({ payload: JSON.parse(message.data) })
          } catch (_error) {
            /* a malformed frame is dropped, never trusted */
          }
        }
        return function () {
          source.close()
        }
      })
  }

  Object.defineProperty(window, '__adeaDesktop', {
    value: Object.freeze({
      invoke: invoke,
      listen: listen,
      devExecute: executeDev,
      streamAttachProof: streamAttachProof
    }),
    configurable: false,
    writable: false,
  })
})()
`
}
