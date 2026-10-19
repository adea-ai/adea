// The packaged desktop acceptance runbook must stay true.
//
// A runbook is only useful while it matches the repository: a lane it names
// may be renamed, a script it points at may be deleted, an npm entry may
// change, and a `BLOCKED` row may quietly start reading as `SOURCE-VERIFIED`
// because someone edited a status word. This test keeps the runbook honest
// without running any of the lanes it describes.
//
// It checks four things:
//
//   1. every lane, script, and command the runbook names still exists, and
//      every npm script it quotes still carries exactly that command;
//   2. every acceptance item is present with a status, and every `BLOCKED`
//      item names the clearance it needs;
//   3. the credential-store account distinguishes the historical ATTEMPTED
//      access from the UNCONFIRMED cause, and does not promote a consent
//      dialog hypothesis into a finding;
//   4. the runbook never claims a live install, a native credential run, or a
//      real account.
//
// Nothing here touches the OS credential store, installs an app, opens a
// browser, or uses an account.
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const repositoryRoot = new URL('../../../', import.meta.url).pathname
const runbookPath = join(repositoryRoot, 'docs/guides/packaged-desktop-acceptance-runbook.md')
const runbook = readFileSync(runbookPath, 'utf8')

const rootManifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}

/** The lanes and files the runbook names verbatim, repo-relative. */
const REQUIRED_PATHS = [
  'apps/desktop/shell/scripts/packaged-worktree-smoke.ts',
  'apps/desktop/shell/scripts/packaged-vault-smoke.ts',
  'apps/desktop/shell/scripts/packaged-owner-journey.ts',
  'apps/desktop/shell/scripts/packaged-install.ts',
  'apps/desktop/shell/src/desktop-auth-store.ts',
  'apps/desktop/shell/src/dev-runtime/vault.ts',
  'apps/desktop/scripts/verify-release-target.mjs',
  'apps/desktop/tests/packaged-worktree-credential-isolation.test.ts',
  'apps/desktop/tests/installer-archive.test.ts',
  'scripts/test-m10-33-packaged-vault.mjs',
  'scripts/release-target-verifier.test.ts',
  'scripts/fresh-postgres-acceptance/auth-lifecycle.ts',
]

/** The spec pages the runbook links. The runbook links them doc-relative. */
const REQUIRED_SPECS = [
  'docs/specs/desktop-auth.md',
  'docs/specs/updater.md',
  'docs/specs/dev-runtime.md',
]

const REQUIRED_SCRIPTS: Record<string, string> = {
  'test:packaged:vault': 'bun scripts/test-m10-33-packaged-vault.mjs',
  'test:packaged:owner-journey': 'bun apps/desktop/shell/scripts/packaged-owner-journey.ts',
}

describe('the acceptance runbook names only lanes that exist', () => {
  test('every file the runbook depends on is present', () => {
    for (const path of REQUIRED_PATHS) {
      expect(existsSync(join(repositoryRoot, path)), `missing lane or file: ${path}`).toBe(true)
      // The runbook must actually name it, not merely the test know it. A
      // lane under `apps/desktop` may be named repo-relative or
      // app-relative; either resolves for a reader.
      const appRelative = path.replace('apps/desktop/', '')
      expect(
        runbook.includes(path) || runbook.includes(appRelative),
        `the runbook does not name ${path}`
      ).toBe(true)
    }
  })

  test('every spec the runbook links exists and is linked', () => {
    for (const spec of REQUIRED_SPECS) {
      expect(existsSync(join(repositoryRoot, spec)), `missing spec: ${spec}`).toBe(true)
      // The runbook links the spec from `docs/guides/`, so it names the
      // file by name, doc-relative.
      const name = spec.slice('docs/specs/'.length)
      expect(runbook.includes(name), `the runbook does not link ${spec}`).toBe(true)
    }
  })

  test('every npm script the runbook quotes still carries that command', () => {
    for (const [name, command] of Object.entries(REQUIRED_SCRIPTS)) {
      expect(rootManifest.scripts[name], `npm script ${name} is gone`).toBe(command)
      expect(runbook).toContain(name)
    }
  })

  test('the runbook is a tracked document, not a scratch file', () => {
    expect(runbookPath.endsWith('docs/guides/packaged-desktop-acceptance-runbook.md')).toBe(true)
    expect(runbook.length).toBeGreaterThan(2_000)
  })
})

describe('every acceptance item carries a status and, when blocked, a clearance', () => {
  const items = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10']

  test('all items are present', () => {
    for (const item of items) {
      expect(runbook, `acceptance item ${item} is missing`).toContain(`| ${item} `)
    }
  })

  test('the blocked items are the live ones, and each names a clearance', () => {
    // These are the items that need a live install, a native credential
    // store, or a real account. Each must be marked BLOCKED (or MISSING
    // LANE, where no lane exists yet) and must state what clearance it
    // needs.
    const clearanceTable = runbook.slice(
      runbook.indexOf('## Blocked items and the clearance each needs')
    )
    for (const item of ['A6', 'A7', 'A8', 'A9', 'A10']) {
      const row = runbook.split('\n').find((line) => line.startsWith(`| ${item} `))
      expect(row, `acceptance item ${item} has no row`).toBeDefined()
      expect(row).toMatch(/`BLOCKED`|`MISSING LANE`/)
      // And it must have a clearance row naming what it is blocked on and
      // what clearance it needs.
      const clearance = clearanceTable.split('\n').find((line) => line.startsWith(`| ${item} `))
      expect(clearance, `blocked item ${item} has no clearance row`).toBeDefined()
      const cells = clearance!.split('|').map((cell) => cell.trim())
      // cells[1] is the empty leading cell; [2] is "blocked on"; [3] is
      // "clearance required".
      expect(cells[2]?.length ?? 0).toBeGreaterThan(0)
      expect(cells[3]?.length ?? 0).toBeGreaterThan(0)
    }
  })

  test('the source-verified items are the ones that need no live environment', () => {
    for (const item of ['A1', 'A2', 'A3', 'A4', 'A5']) {
      const row = runbook.split('\n').find((line) => line.startsWith(`| ${item} `))
      expect(row, `acceptance item ${item} has no row`).toBeDefined()
      expect(row).toContain('`SOURCE-VERIFIED`')
      // A source-verified item must not also be marked blocked.
      expect(row).not.toContain('`BLOCKED`')
    }
  })
})

describe("the runbook's credential-store account stays honest", () => {
  // These assertions are written as `includes` booleans so a failure prints
  // a short message rather than the whole runbook.
  const states = (text: string) => expect(runbook.includes(text)).toBe(true)

  test('it distinguishes the attempted access from the confirmed outcome', () => {
    // The attempt is established.
    states('credential-store **write was attempted**')
    states('did not complete within')
    // The confirmation is explicitly withheld.
    states('not established')
    states('is not claimed either way')
  })

  test('it does not promote a consent-dialog hypothesis into a cause', () => {
    // The cause must be named as unconfirmed, and the dialog must be named
    // as a hypothesis only.
    states('hypothesis, not a confirmed cause')
    states('cause is unconfirmed')
    states('Do not report this as')
  })

  test('it records that the production vault and the true-keychain lane are unchanged', () => {
    states('The production vault in')
    states('is unchanged and')
  })
})

describe('the runbook claims no live execution', () => {
  const states = (text: string) => expect(runbook.includes(text)).toBe(true)

  test('it states plainly that nothing live was run', () => {
    states('No keychain or')
    states('no application was installed or launched')
    states('no real account, credential, or production service')
    states('was **not** run')
  })

  test('it lists the lanes that were deliberately not executed', () => {
    states('Deliberately not executed')
    for (const skipped of [
      'tests/packaged-worktree-containment.test.ts',
      'test:packaged:vault',
      'test:packaged:owner-journey',
    ]) {
      states(skipped)
    }
  })
})
