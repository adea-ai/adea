import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const selector = fileURLToPath(new URL('./desktop-shell-changes.mjs', import.meta.url))
const zeroSha = '0'.repeat(40)
const realGitTimeout = 60_000

type Repository = {
  directory: string
  git: (...args: string[]) => string
  write: (path: string, contents: string) => void
  commit: (message: string) => string
  head: () => string
}

function withRepository(run: (repository: Repository) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'adea-desktop-shell-scope-'))
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: directory,
      encoding: 'utf8',
    }).trim()
  const repository: Repository = {
    directory,
    git,
    write(path, contents) {
      const fullPath = join(directory, path)
      mkdirSync(dirname(fullPath), { recursive: true })
      writeFileSync(fullPath, contents)
    },
    commit(message) {
      git('add', '--all')
      git('commit', '-qm', message)
      return git('rev-parse', 'HEAD')
    },
    head() {
      return git('rev-parse', 'HEAD')
    },
  }

  try {
    git('init', '-q')
    git('config', 'user.name', 'Desktop scope fixture')
    git('config', 'user.email', 'desktop-scope@example.invalid')
    repository.write('README.md', 'Adea fixture\n')
    repository.write('apps/desktop/shell/src/main.ts', 'export const main = true\n')
    repository.write('apps/web/src/lib/desktop-bridge.ts', 'export const bridge = true\n')
    repository.write('apps/web/vite.desktop.config.ts', 'export default {}\n')
    repository.commit('fixture base')
    run(repository)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function select(repository: Repository, eventName: 'pull_request' | 'push', event: object) {
  const runnerDirectory = mkdtempSync(join(tmpdir(), 'adea-desktop-shell-event-'))
  const eventPath = join(runnerDirectory, 'event.json')
  const outputPath = join(runnerDirectory, 'output.txt')
  writeFileSync(eventPath, JSON.stringify(event))
  writeFileSync(outputPath, '')

  try {
    execFileSync('node', [selector], {
      cwd: repository.directory,
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: eventName,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: outputPath,
      },
    })
    return readFileSync(outputPath, 'utf8').trim()
  } finally {
    rmSync(runnerDirectory, { recursive: true, force: true })
  }
}

function pullRequest(base: string, head: string) {
  return { pull_request: { base: { sha: base }, head: { sha: head } } }
}

function push(before: string, after: string) {
  return { before, after }
}

// These integration cases spawn Git and selector processes against disposable repos.
// Keep their deadline local so the other boundary tests retain their existing timeout.
test(
  'docs-only pull requests and pushes skip the desktop build',
  () => {
    withRepository((repository) => {
      const base = repository.head()
      repository.write('docs/desktop-setup.md', 'Document the setup.\n')
      const head = repository.commit('document desktop setup')

      expect(select(repository, 'pull_request', pullRequest(base, head))).toBe('desktop=false')
      expect(select(repository, 'push', push(base, head))).toBe('desktop=false')
    })
  },
  realGitTimeout
)

test(
  'desktop source, build configuration, workflow, and dependency changes run the gate',
  () => {
    const relevantChanges = [
      ['apps/desktop/shell/src/main.ts', 'export const changed = true\n'],
      ['apps/web/vite.desktop.config.ts', 'export default { build: { target: "desktop" } }\n'],
      ['bun.lock', 'lockfileVersion = 1\n'],
      ['.github/workflows/desktop-shell.yml', 'name: Desktop shell\n'],
      ['scripts/desktop-shell-changes.mjs', 'export const changed = true\n'],
      ['scripts/desktop-shell-changes.test.ts', 'test("changed", () => {})\n'],
    ] as const

    withRepository((repository) => {
      let before = repository.head()
      for (const [path, contents] of relevantChanges) {
        repository.write(path, contents)
        const head = repository.commit(`change ${path}`)

        expect(select(repository, 'pull_request', pullRequest(before, head))).toBe('desktop=true')
        expect(select(repository, 'push', push(before, head))).toBe('desktop=true')
        before = head
      }
    })
  },
  realGitTimeout
)

test(
  'a rename out of the desktop path and a deletion retain the old desktop path',
  () => {
    withRepository((repository) => {
      let before = repository.head()
      repository.git('mv', 'apps/web/src/lib/desktop-bridge.ts', 'apps/web/src/lib/bridge.ts')
      let head = repository.commit('rename desktop bridge')

      expect(select(repository, 'pull_request', pullRequest(before, head))).toBe('desktop=true')
      before = head

      rmSync(join(repository.directory, 'apps/desktop/shell/src/main.ts'))
      head = repository.commit('remove desktop entry')

      expect(select(repository, 'pull_request', pullRequest(before, head))).toBe('desktop=true')
    })
  },
  realGitTimeout
)

test(
  'missing, malformed, zero, or unavailable refs fail closed to the desktop gate',
  () => {
    withRepository((repository) => {
      const head = repository.head()
      const invalidEvents = [
        {},
        { pull_request: { base: { sha: 'not-a-sha' }, head: { sha: head } } },
        pullRequest(zeroSha, head),
        pullRequest('f'.repeat(40), head),
      ]

      for (const event of invalidEvents) {
        expect(select(repository, 'pull_request', event)).toBe('desktop=true')
      }

      expect(select(repository, 'push', { before: head, after: zeroSha })).toBe('desktop=true')
    })
  },
  realGitTimeout
)
