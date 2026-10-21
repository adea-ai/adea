import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The self-hosted section attaches hosts to an account, so the account id it is given must come
// from the host's own session. The shell's bootstrap query is a shared cache that can outlive a
// sign-out, so the shell never derives the id from it. This reads the source because the shell's
// standalone settings mount has no rendered harness; the rendered account-swap, guest-to-signed-in
// and late-response cases run in e2e/self-hosted-workspace-details.spec.ts (its Settings > Workspaces harness).
const src = join(import.meta.dir, '../../src')

test('the standalone shell passes the host-supplied principal to Settings, not bootstrap data', () => {
  const code = readFileSync(join(src, 'conventional-workspace-shell.tsx'), 'utf8')
  const mount =
    /<WorkspaceSettingsDialog\s+accountAuthenticated=\{[^}]*\}\s+accountPrincipalId=\{([\s\S]*?)\}\s+accountLabel/.exec(
      code
    )
  expect(mount).not.toBeNull()
  const accessor = mount![1]!
  expect(accessor).toContain('account?.principalId')
  expect(accessor).not.toContain('sessionIdentity')
  expect(accessor).not.toContain('bootstrap')
})

test('the section shows no hosts without an account id', () => {
  const code = readFileSync(join(src, 'self-hosted-connections-section.tsx'), 'utf8')
  expect(code).toContain('when={props.accountId?.()}')
  expect(code).toContain('Self-hosted hosts need a signed-in account.')
})
