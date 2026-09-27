import { appendFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const desktopPaths = [
  /^apps\/desktop\//,
  /^apps\/web\/vite\.desktop\.config\.ts$/,
  /^apps\/web\/src\/lib\/desktop-[^/]+\.ts$/,
  /^apps\/web\/src\/components\/desktop-[^/]+\.tsx$/,
  /^apps\/web\/src\/components\/workspace-navigation[^/]*\.tsx$/,
  /^apps\/web\/src\/components\/version-dialog\.tsx$/,
  /^packages\/dev-view\/src\/dev-workspace-entry\.tsx$/,
  /^packages\/dev-view\/src\/terminal\/fixture-terminal-pane\.tsx$/,
  /^scripts\/desktop-[^/]+\.test\.ts$/,
  /^scripts\/check-desktop-origins\.mjs$/,
  /^scripts\/check-desktop-client-browser\.mjs$/,
  /^scripts\/test-suite-boundary\.test\.ts$/,
  /^scripts\/desktop-shell-changes\.mjs$/,
  /^bun\.lock$/,
  /^\.github\/workflows\/desktop-shell\.yml$/,
]

function isFullGitSha(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) && !/^0{40}$/.test(value)
}

function changedPaths(eventName, event) {
  let before
  let after

  if (eventName === 'pull_request') {
    before = event.pull_request?.base?.sha
    after = event.pull_request?.head?.sha
  } else if (eventName === 'push') {
    before = event.before
    after = event.after
  } else {
    throw new Error('Unsupported event for desktop change selection')
  }

  if (!isFullGitSha(before) || !isFullGitSha(after)) {
    throw new Error('Missing or invalid immutable event refs')
  }

  // Compare the event's exact trees. Disabling rename detection keeps the
  // removed path in the result when a desktop input is renamed elsewhere.
  return execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', before, after], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .split('\0')
    .filter(Boolean)
}

let desktop = true

try {
  const event = JSON.parse(readFileSync(process.env['GITHUB_EVENT_PATH'], 'utf8'))
  const paths = changedPaths(process.env['GITHUB_EVENT_NAME'], event)
  desktop = paths.some((path) => desktopPaths.some((pattern) => pattern.test(path)))
} catch {
  // A selector failure must not turn a required build into a successful skip.
  console.warn('::warning::Desktop change detection failed; running the full Desktop shell gate.')
}

appendFileSync(process.env['GITHUB_OUTPUT'], `desktop=${desktop}\n`)
console.log(JSON.stringify({ desktop }))
