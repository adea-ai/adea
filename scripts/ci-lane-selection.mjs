import { appendFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Selects what the path-sensitive pull-request lanes (the workspace visual lane and the Start host
// lane) must run for a change. The lanes used to be path-filtered at the workflow level, which
// never reports a check on a pull request that touches none of the paths and so cannot be a
// required check. They now always trigger; this selector decides inside the run whether the
// expensive job is applicable, and a gate job reports the result either way.

const webInputs = [
  /^apps\/web\//,
  /^packages\//,
  /^scripts\//,
  /^bun\.lock$/,
  /^package\.json$/,
  /^playwright\.config\.ts$/,
  // Build and type configuration shared by every package: a change here can alter what the
  // lanes build or run without touching any path above.
  /^vite\.config\.ts$/,
  /^tsconfig\.base\.json$/,
  /^tsconfig\.json$/,
  /^bunfig\.toml$/,
]

const lanes = {
  visual: [...webInputs, /^\.github\/workflows\/visual-lane\.yml$/],
  host: [
    ...webInputs,
    /^compose\.yml$/,
    /^infra\/postgres\//,
    /^\.github\/workflows\/tanstack-start\.yml$/,
  ],
}

// A pixel suite is skipped only when every changed input is the other suite's own spec or
// baselines. Everything else (shared UI, packages, configuration, the lane itself) can move
// pixels in both suites, so it runs both. The previous selection alternated suites by pull-request
// number parity, which let a regression ride in on a pull request that happened to run the other
// suite.
const visualSuites = {
  workspace: /^apps\/web\/e2e\/conventional-workspace\.spec\.ts(-snapshots\/.*)?$/,
  chat: /^apps\/web\/e2e\/chat-view-visual\.spec\.ts(-snapshots\/.*)?$/,
}

export function selectLane(lane, paths) {
  const inputs = lanes[lane]
  if (!inputs) throw new Error(`Unknown lane: ${lane}`)
  const relevant = paths.filter((path) => inputs.some((pattern) => pattern.test(path)))
  const selection = { applicable: relevant.length > 0 }
  if (lane === 'visual') {
    const exclusive = (suite) => relevant.every((path) => visualSuites[suite].test(path))
    selection.workspace = selection.applicable && !exclusive('chat')
    selection.chat = selection.applicable && !exclusive('workspace')
  }
  return selection
}

// Selection that runs everything: dispatches, unsupported events, and any failure to read the
// diff. A selector failure must never turn a required lane into a successful skip.
export function fullSelection(lane) {
  return lane === 'visual'
    ? { applicable: true, workspace: true, chat: true }
    : { applicable: true }
}

function isFullGitSha(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) && !/^0{40}$/.test(value)
}

function changedPaths(event) {
  const before = event.pull_request?.base?.sha
  const after = event.pull_request?.head?.sha
  if (!isFullGitSha(before) || !isFullGitSha(after)) {
    throw new Error('Missing or invalid immutable event refs')
  }
  // Compare the event's exact trees. Disabling rename detection keeps the removed path in the
  // result when an input is renamed elsewhere.
  return execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', before, after], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .split('\0')
    .filter(Boolean)
}

function main() {
  const lane = process.argv[2]
  if (!lanes[lane])
    throw new Error(`Usage: ci-lane-selection.mjs <${Object.keys(lanes).join('|')}>`)
  let selection = fullSelection(lane)
  if (process.env['GITHUB_EVENT_NAME'] === 'pull_request') {
    try {
      const event = JSON.parse(readFileSync(process.env['GITHUB_EVENT_PATH'], 'utf8'))
      selection = selectLane(lane, changedPaths(event))
    } catch {
      console.warn(`::warning::Change detection failed; running the full ${lane} lane.`)
    }
  }
  const lines = Object.entries(selection).map(([key, value]) => `${key}=${value}`)
  appendFileSync(process.env['GITHUB_OUTPUT'], `${lines.join('\n')}\n`)
  console.log(JSON.stringify(selection))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
