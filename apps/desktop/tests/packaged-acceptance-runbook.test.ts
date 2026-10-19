// The packaged desktop acceptance runbook must stay true.
//
// A runbook is only useful while it matches the repository: a lane it names
// may be renamed, a script it points at may be deleted, an npm entry may
// change, and a `BLOCKED` row may quietly start reading as `SOURCE-VERIFIED`
// because someone edited a status word. This test keeps the runbook honest
// without running any of the lanes it describes.
//
// It checks that:
//
//   1. every lane, script, and command the runbook names still exists, and
//      every npm script it quotes still carries exactly that command;
//   2. every acceptance item is present with a status, and every item that is
//      not executed names what it needs;
//   3. the credential-store account distinguishes the historical ATTEMPTED
//      access from the UNCONFIRMED cause, and does not promote a consent
//      dialog hypothesis into a finding;
//   4. the runbook never claims a live install, a native credential run, or a
//      real account;
//   5. a claim is never mapped onto a lane that does not cover it — the
//      real-login claim in particular must not borrow the owner-journey lane;
//   6. a lane's service isolation is stated accurately, so a disposable
//      probe is not described as exercising a production service;
//   7. inherited evidence is labelled as inherited and distinguished from the
//      checks actually run on this head;
//   8. every command states its working directory.
//
// Nothing here touches the OS credential store, installs an app, opens a
// browser, or uses an account.
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const repositoryRoot = new URL('../../../', import.meta.url).pathname
const runbookPath = join(repositoryRoot, 'docs/guides/packaged-desktop-acceptance-runbook.md')
const runbook = readFileSync(runbookPath, 'utf8')
/** The runbook with whitespace collapsed, so an assertion is not defeated by
 *  the document's line wrapping. */
const flat = runbook.replace(/\s+/g, ' ')

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

/** The acceptance-items table row for an item. */
function row(id: string): string {
  return runbook.split('\n').find((line) => line.startsWith(`| ${id} `)) ?? ''
}

/** One `### <id> — …` section of the runbook, whitespace-collapsed. */
function section(id: string): string {
  const start = runbook.indexOf(`### ${id} `)
  if (start === -1) return ''
  const rest = runbook.slice(start)
  const next = rest.slice(1).search(/\n#{2,3} /)
  return (next === -1 ? rest : rest.slice(0, next + 1)).replace(/\s+/g, ' ')
}

/** Asserts that a (possibly wrapped) phrase appears in the runbook. */
const states = (text: string) => expect(flat.includes(text)).toBe(true)

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
      expect(runbook.includes(name)).toBe(true)
    }
  })

  test('the runbook is a tracked document, not a scratch file', () => {
    expect(runbookPath.endsWith('docs/guides/packaged-desktop-acceptance-runbook.md')).toBe(true)
    expect(runbook.length).toBeGreaterThan(2_000)
  })
})

describe('every acceptance item carries a status and, when not executed, what it needs', () => {
  const items = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11']

  test('all items are present', () => {
    for (const item of items) {
      expect(row(item), `acceptance item ${item} has no row`).not.toBe('')
      expect(row(item)).toMatch(/`(SOURCE-VERIFIED|INHERITED|PENDING|BLOCKED|MISSING LANE)`/)
    }
  })

  test('the items that are not executed name what they need', () => {
    const table = runbook.slice(runbook.indexOf('## Items not yet executed'))
    for (const item of ['A6', 'A7', 'A8', 'A9', 'A10', 'A11']) {
      const clearance = table.split('\n').find((line) => line.startsWith(`| ${item} `))
      expect(clearance, `item ${item} has no "what it needs" row`).toBeDefined()
      const cells = clearance!.split('|').map((cell) => cell.trim())
      // cells[1] is the empty leading cell; [2] is the state; [3] is what it
      // needs.
      expect(cells[2]?.length ?? 0).toBeGreaterThan(0)
      expect(cells[3]?.length ?? 0).toBeGreaterThan(0)
    }
  })

  test('the source-verified items are the ones run on this head', () => {
    for (const item of ['A3', 'A4', 'A5']) {
      expect(row(item), `acceptance item ${item} has no row`).toContain('`SOURCE-VERIFIED`')
      expect(row(item)).not.toContain('`BLOCKED`')
      // The runbook says these were run on this head.
      expect(section(item)).toContain('Run on this head')
    }
  })
})

describe('a claim is never mapped onto a lane that does not cover it', () => {
  test('the real-login claim is marked as having no lane', () => {
    expect(row('A10')).toContain('`MISSING LANE`')
    expect(section('A10')).toContain('No lane covers this claim')
    // The real-login row must not name the owner-journey lane as its lane.
    expect(row('A10')).not.toContain('test:packaged:owner-journey')
  })

  test('the owner-journey lane is described as what it actually is', () => {
    const ownerJourney = section('A11')
    expect(ownerJourney).toContain('host-side')
    expect(ownerJourney).toContain('project')
    expect(ownerJourney).toContain('worktree')
    expect(ownerJourney).toContain('archive')
    // It must state that it does NOT do sign-in, cloud auth, or desktop-auth
    // persistence.
    expect(ownerJourney).toContain('**not** sign-in')
    expect(ownerJourney).toContain('**not** cloud authentication')
    expect(ownerJourney).toContain('**not** desktop-auth persistence')
  })

  test('the real-login section states the owner-journey lane is not evidence for it', () => {
    const realLogin = section('A10')
    expect(realLogin).toContain('is **not** evidence for it')
    expect(realLogin).toContain('performs **no** desktop login')
    expect(realLogin).toContain('**no** cloud authentication')
    expect(realLogin).toContain('desktop-auth store verification')
    // And it must name the source-level coverage that exists instead, so a
    // reader is not left with nothing.
    expect(realLogin).toContain('packages/auth/tests/unit')
    expect(realLogin).toContain('desktop-auth-store.test.ts')
  })

  test('the owner-journey lane is not described as a sign-in lane anywhere', () => {
    // The lane's own command may be named, but never as the lane that
    // proves a real sign-in.
    expect(flat).not.toContain('real sign-in lane')
    expect(flat).not.toContain('sign-in acceptance')
  })
})

describe("a lane's service isolation is stated accurately", () => {
  test('the vault probe is described as using disposable services', () => {
    const vault = section('A7')
    expect(vault).toContain('com.adea.m10.vault.<UUID>')
    expect(vault).toContain('disposable')
    // The production service may be named ONLY as the thing the lane does
    // NOT write. It must never be named as the lane's own service.
    expect(vault).toMatch(
      /\*\*without\*\* writing the production `com\.adea\.desktop\.dev-runtime` service/
    )
    expect(vault).not.toContain('for service `com.adea.desktop.dev-runtime`')
  })

  test('the desktop-auth section does not borrow the vault probe as its lane', () => {
    const desktopAuth = section('A8')
    expect(desktopAuth).toContain('MISSING LANE')
    expect(desktopAuth).toContain('com.adea.m10.vault.<UUID>')
    // Again: the production service may appear only in contrast.
    expect(desktopAuth).toMatch(
      /not `com\.adea\.desktop` and not the production `com\.adea\.desktop\.dev-runtime` service/
    )
    expect(desktopAuth).not.toContain('for service `com.adea.desktop.dev-runtime`')
  })
})

describe('inherited evidence is labelled and distinguished from checks run here', () => {
  test('the inherited items are marked INHERITED and cite the merged head', () => {
    for (const item of ['A1', 'A2']) {
      expect(row(item), `acceptance item ${item} has no row`).toContain('`INHERITED`')
      expect(row(item)).not.toContain('`SOURCE-VERIFIED`')
      expect(section(item)).toContain('Inherited, not re-run on this head')
    }
    // The cited exact head and its merge commit.
    expect(flat).toContain('3eaf0e45838e2b2ac805680702c0fb63b878a4af')
    expect(flat).toContain('4505c88473e1d29b4df67497c6561974d05378df')
  })

  test('the runbook separates inherited evidence from what ran here', () => {
    expect(flat).toContain('Run on this head.')
    expect(flat).toContain('Not executed on this head')
    // The summary must say which items are inherited.
    expect(flat).toContain('A1 and A2 are inherited')
  })
})

describe('the containment lane is described as host-side execution, not an install', () => {
  test('it is pending, not blocked, and says so', () => {
    expect(row('A6')).toContain('`PENDING`')
    expect(row('A6')).not.toContain('`BLOCKED`')
    expect(section('A6')).toContain('Pending, not blocked')
    expect(section('A6')).toContain('It was **not** executed on this head')
  })

  test('it states that it neither installs nor launches the app', () => {
    const lane = section('A6')
    expect(lane).toContain('host-side execution, not an app install and not an app launch')
    expect(lane).toContain('does not install the app')
    expect(lane).toContain('does not launch the app')
    expect(lane).toContain('temporary')
  })
})

describe("the runbook's credential-store account stays honest", () => {
  // These assertions are written as `includes` booleans so a failure prints
  // a short message rather than the whole runbook.
  const statesHere = (text: string) => expect(flat.includes(text)).toBe(true)

  test('it distinguishes the attempted access from the confirmed outcome', () => {
    // The attempt is established.
    statesHere('credential-store **write was attempted**')
    statesHere('did not complete within')
    // The confirmation is explicitly withheld.
    statesHere('not established')
    statesHere('is not claimed either way')
  })

  test('it does not promote a consent-dialog hypothesis into a cause', () => {
    // The cause must be named as unconfirmed, and the dialog must be named
    // as a hypothesis only.
    statesHere('hypothesis, not a confirmed cause')
    statesHere('cause is unconfirmed')
    statesHere('Do not report this as')
  })

  test('it records that the production vault and the true-keychain lane are unchanged', () => {
    statesHere('The production vault in')
    statesHere('is unchanged and')
  })
})

describe('the runbook claims no live execution', () => {
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

describe('every command states its working directory', () => {
  test('each shell block is preceded by a working-directory line', () => {
    const lines = runbook.split('\n')
    let blocks = 0
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index]?.trim() !== '```sh') continue
      blocks += 1
      // The nearest preceding non-empty line must name the working
      // directory.
      let previous = index - 1
      while (previous >= 0 && (lines[previous] ?? '').trim() === '') previous -= 1
      const context = lines[previous] ?? ''
      expect(
        context.includes('Working directory:'),
        `the shell block at line ${index + 1} has no working directory: ${context}`
      ).toBe(true)
    }
    expect(blocks).toBeGreaterThan(0)
  })

  test('both working directories are used', () => {
    expect(flat).toContain('Working directory: **repository root**')
    expect(flat).toContain('Working directory: **apps/desktop**')
  })
})
