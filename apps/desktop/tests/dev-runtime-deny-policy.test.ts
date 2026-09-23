// Rule-level pins for the default-deny policy (#622). The integration cases in
// `dev-runtime-files-provider.test.ts` prove the rules fire on the real dispatch
// path; these pin the rule boundary itself, especially the files that must stay
// readable so the policy cannot quietly over-block an approved project.
import { expect, test } from 'bun:test'

import { evaluateDenyPolicy } from '../shell/src/dev-runtime/files/deny-policy'

const denied = (path: string, protectedRoots?: readonly string[]) =>
  evaluateDenyPolicy(path, protectedRoots ? { protectedRoots } : undefined).denied

test('private key material is denied by name, in any directory', () => {
  expect(denied('/work/project/id_rsa')).toBe(true)
  expect(denied('/work/project/deploy/id_ed25519')).toBe(true)
  expect(denied('/work/project/certs/server.p12')).toBe(true)
  expect(denied('/work/project/certs/server.pfx')).toBe(true)
  expect(denied('/work/project/certs/keystore.jks')).toBe(true)
  expect(denied('/work/project/tls/private.key')).toBe(true)
})

test('public and non-secret neighbours stay readable', () => {
  // The names below are the ones an approved project legitimately needs: a
  // public key, a public certificate, a project dotfile, a lockfile-adjacent
  // credential-free config.
  expect(denied('/work/project/id_ed25519.pub')).toBe(false)
  expect(denied('/work/project/certs/cert.pem')).toBe(false)
  expect(denied('/work/project/.env')).toBe(false)
  expect(denied('/work/project/.env.local')).toBe(false)
  expect(denied('/work/project/.npmrc')).toBe(false)
  expect(denied('/work/project/compose.yml')).toBe(false)
  expect(denied('/work/project/src/keyboard.ts')).toBe(false)
})

test('credential stores are denied anywhere in the tree, not only under $HOME', () => {
  expect(denied('/Users/someone/.ssh/id_rsa')).toBe(true)
  expect(denied('/Users/someone/.aws/credentials')).toBe(true)
  expect(denied('/Users/someone/.gnupg/secring.gpg')).toBe(true)
  expect(denied('/Users/someone/.kube/config')).toBe(true)
  expect(denied('/Users/someone/.docker/config.json')).toBe(true)
  expect(denied('/Users/someone/.config/gcloud/application_default_credentials.json')).toBe(true)
  expect(denied('/Users/someone/Library/Keychains/login.keychain-db')).toBe(true)
  // A vendored copy is no less a credential store.
  expect(denied('/work/project/vendor/.ssh/config')).toBe(true)
})

test('protected roots refuse exactly themselves and their descendants', () => {
  const roots = ['/Users/someone/Library/Application Support/Adea/local-content']
  expect(denied(`${roots[0]}/agent-hq-content.sqlite`, roots)).toBe(true)
  expect(denied(roots[0], roots)).toBe(true)
  // A sibling that merely shares a prefix is not inside the root.
  expect(
    denied('/Users/someone/Library/Application Support/Adea/local-content-backup/x', roots)
  ).toBe(false)
  // Trailing slashes and backslashes normalize.
  expect(denied('/root/local-content/db', ['/root/local-content/'])).toBe(true)
})

test('a rule names itself so a refusal can explain what it refused', () => {
  const verdict = evaluateDenyPolicy('/work/project/id_rsa')
  expect(verdict).toMatchObject({ denied: true, rule: 'key_material' })
  const store = evaluateDenyPolicy('/work/project/.aws/credentials')
  expect(store).toMatchObject({ denied: true, rule: 'credential_store' })
  const authority = evaluateDenyPolicy('/data/local-content/db', {
    protectedRoots: ['/data/local-content'],
  })
  expect(authority).toMatchObject({ denied: true, rule: 'agent_hq_authority' })
})
