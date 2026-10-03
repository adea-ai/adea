// Source control app — GitLab collaboration live READ pass (opt-in evidence).
//
// The fixture suite (tests/dev-runtime-gitlab-provider.test.ts) proves the
// handlers against a scripted glab. This lane runs the same signed-channel
// construction against a real GitLab project, read-only: nothing is ever
// written. Every reply is re-decoded through the strict client decoders, so
// a GraphQL field GitLab does not serve, or a mapping that drifts from the
// contract, fails here.
//
// By default it uses the PRODUCTION glab transport (the user's `glab auth`
// context). `--anonymous` swaps in an HTTPS transport that answers the same
// `glab api` argv for public projects without credentials; reads GitLab
// gates behind sign-in (the account, job logs) then surface as typed
// refusals, which is the contract.
//
// Usage:
//   bun apps/desktop/tests/live/gitlab-collaboration-live-read.ts \
//     [--project gitlab-org/gitlab-runner] [--mr <iid>] [--anonymous]
//
// Exit code 0 only when every read decoded (or refused with a typed error
// where anonymous access is not allowed).
import { execFileSync } from 'node:child_process'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  devCommandProofMessage,
  devOperationDecoders,
  devOperationDefinitions,
  type DevCommand,
  type DevOperation,
  type DevReply,
  type Scope,
} from '../../../../packages/types/src/dev-runtime'

import { createChannelAuthority } from '../../shell/src/dev-runtime/channel/authority'
import { registerGitlabRuntime, type GlabRunner } from '../../shell/src/dev-runtime/gitlab/register'

function argOf(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const PROJECT = argOf('--project') ?? 'gitlab-org/gitlab-runner'
const ANONYMOUS = process.argv.includes('--anonymous')
const REPO_ID = '00000000-0000-4000-8000-000000005302'
const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

// The provider reads only `remote.origin.url`, so an empty repository with
// the project's origin stands in for a checkout.
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'adea-gl-live-')))
execFileSync('git', ['init', '-q', ROOT])
execFileSync('git', ['-C', ROOT, 'remote', 'add', 'origin', `https://gitlab.com/${PROJECT}.git`])

/** `glab api <path> --hostname <host> [--method M] [--input - …]` over
 *  anonymous HTTPS, for public projects only. */
const anonymousGlab: GlabRunner = async (args, options) => {
  if (args[0] !== 'api') return { stdout: '', stderr: 'unsupported', exitCode: 1 }
  const path = args[1]!
  const host = args[args.indexOf('--hostname') + 1] ?? 'gitlab.com'
  const method = args.includes('--method') ? args[args.indexOf('--method') + 1]! : 'GET'
  const url = path === 'graphql' ? `https://${host}/api/graphql` : `https://${host}/api/v4/${path}`
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(options?.stdin !== undefined ? { body: options.stdin } : {}),
  })
  const text = await response.text()
  if (!response.ok)
    return { stdout: '', stderr: `HTTP ${response.status} ${text.slice(0, 200)}`, exitCode: 1 }
  return { stdout: text, stderr: '', exitCode: 0 }
}

const authority = createChannelAuthority({
  shellHost: '127.0.0.1',
  shellOrigin: 'https://127.0.0.1:4789',
})
const repo = { repoId: REPO_ID, canonicalRoot: ROOT }
registerGitlabRuntime({
  authority,
  scope,
  resolveRepo: (repoId) => (repoId === REPO_ID ? repo : undefined),
  listRepos: () => [repo],
  ...(ANONYMOUS ? { runGlab: anonymousGlab } : {}),
})

const bootstrap = authority.issueLaunchBootstrap()
const handshake = authority.handshake(
  {
    schemaVersion: 1,
    method: 'dev.runtime.handshake.v1',
    requestId: randomUUID(),
    bootstrap,
    supportedProtocolVersions: ['1'],
    nonce: Buffer.from(randomBytes(16)).toString('base64url'),
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  },
  { trusted: true }
)
if (!handshake.ok) throw new Error('handshake refused')
const secret = Buffer.from(handshake.clientSecret, 'base64url')

async function run<T>(operation: DevOperation, body: Record<string, unknown>): Promise<T> {
  const definition = devOperationDefinitions[operation]
  const idField = definition.resource?.idField
  const command: DevCommand = {
    schemaVersion: 1,
    operation,
    requestId: randomUUID(),
    nonce: Buffer.from(randomBytes(16)).toString('base64url'),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    scope,
    capabilities: [...definition.capabilities],
    ...(definition.resource
      ? { resource: { kind: definition.resource.kind, id: String(body[idField!]), generation: 0 } }
      : {}),
    body,
  }
  const proof = createHmac('sha256', secret)
    .update(
      devCommandProofMessage({
        channelId: handshake.channelId,
        clientCredentialId: handshake.clientCredentialId,
        command,
      }),
      'utf8'
    )
    .digest('base64url')
  const reply = (await authority.execute(
    {
      channelId: handshake.channelId,
      clientCredentialId: handshake.clientCredentialId,
      command,
      proof,
    },
    { trusted: true }
  )) as DevReply
  if (!reply.ok) throw new Error(`${operation}: ${reply.error.code}: ${reply.error.message}`)
  devOperationDecoders[operation].reply({
    schemaVersion: 1,
    operation,
    requestId: command.requestId,
    ok: true,
    value: reply.value,
    observedAt: new Date().toISOString(),
  })
  return reply.value as T
}

type Summary = {
  id: string
  number: number
  title: string
  headSha: string
  baseRef: string
  headRef: string
}
let count = 0
const record = (operation: string, detail: string) => {
  count += 1
  console.log(`ok  ${operation.padEnd(34)} ${detail}`)
}
/** Reads GitLab keeps behind sign-in refuse with a typed error anonymously. */
async function gated(operation: string, read: () => Promise<string>): Promise<void> {
  try {
    record(operation, await read())
  } catch (error) {
    const message = (error as Error).message
    if (!ANONYMOUS || !/: (unauthenticated|unauthorized|not_found): /.test(message)) throw error
    record(operation, `typed refusal without sign-in: ${message.split(': ')[1]}`)
  }
}

try {
  await gated('dev.gitlab.account', async () => {
    const account = await run<{ login: string }>('dev.gitlab.account', {})
    return `signed in as ${account.login}`
  })
  const repository = await run<{
    fullName: string
    defaultBranch: string
    defaultBranchHead?: { checks: string }
  }>('dev.gitlab.repository', { repoId: REPO_ID, refresh: true })
  record(
    'dev.gitlab.repository',
    `${repository.fullName}, default ${repository.defaultBranch}, CI ${repository.defaultBranchHead?.checks ?? 'unknown'}`
  )
  const open = await run<{ items: Summary[]; nextCursor?: string }>(
    'dev.gitlab.pullRequestSummaries',
    {
      repoId: REPO_ID,
      state: 'open',
      limit: 25,
    }
  )
  record(
    'dev.gitlab.pullRequestSummaries',
    `${open.items.length} open${open.nextCursor ? ' (more pages)' : ''}`
  )
  if (open.nextCursor) {
    const next = await run<{ items: Summary[] }>('dev.gitlab.pullRequestSummaries', {
      repoId: REPO_ID,
      state: 'open',
      limit: 25,
      cursor: open.nextCursor,
    })
    record('dev.gitlab.pullRequestSummaries', `${next.items.length} open on page 2`)
  }
  const merged = await run<{ items: Summary[] }>('dev.gitlab.pullRequestSummaries', {
    repoId: REPO_ID,
    state: 'merged',
    limit: 10,
  })
  record('dev.gitlab.pullRequestSummaries', `${merged.items.length} merged (first page)`)

  const wanted = argOf('--mr')
  const target =
    (wanted
      ? [...open.items, ...merged.items].find((mr) => mr.number === Number(wanted))
      : undefined) ??
    open.items[0] ??
    merged.items[0]
  if (!target) throw new Error('the project has no merge requests to read')
  const prId = target.id
  const summary = await run<
    Summary & { behindBy?: number; checks: { state: string; total: number } }
  >('dev.gitlab.pullRequestSummary', { pullRequestId: prId, refresh: true })
  record(
    'dev.gitlab.pullRequestSummary',
    `!${summary.number} ${summary.title.slice(0, 50)} (checks ${summary.checks.state}/${summary.checks.total}, behind ${summary.behindBy ?? '?'})`
  )
  const detail = await run<{ version: number }>('dev.gitlab.pullRequest', {
    pullRequestId: prId,
    refresh: true,
  })
  record('dev.gitlab.pullRequest', `version ${detail.version}`)
  const timeline = await run<{ items: { kind: string }[] }>('dev.gitlab.timeline', {
    pullRequestId: prId,
    limit: 100,
  })
  const kinds = timeline.items.reduce<Record<string, number>>((acc, item) => {
    acc[item.kind] = (acc[item.kind] ?? 0) + 1
    return acc
  }, {})
  record('dev.gitlab.timeline', JSON.stringify(kinds))
  const commits = await run<{ items: { sha: string }[] }>('dev.gitlab.commits', {
    pullRequestId: prId,
    limit: 100,
  })
  record('dev.gitlab.commits', `${commits.items.length} commits`)
  const files = await run<{ items: { path: string; additions: number }[] }>('dev.gitlab.files', {
    pullRequestId: prId,
    limit: 100,
  })
  record('dev.gitlab.files', `${files.items.length} files`)
  const checks = await run<{ items: { id: string; name: string; status: string }[] }>(
    'dev.gitlab.checks',
    {
      pullRequestId: prId,
      limit: 100,
    }
  )
  record('dev.gitlab.checks', `${checks.items.length} jobs on the head pipeline`)
  const bySha = await run<{ items: unknown[] }>('dev.gitlab.checks', {
    pullRequestId: prId,
    sha: summary.headSha,
    limit: 100,
  })
  record('dev.gitlab.checks', `${bySha.items.length} jobs for ${summary.headSha.slice(0, 7)}`)
  const completed = checks.items.find((check) => check.status === 'completed')
  if (completed)
    await gated('dev.gitlab.checkLog', async () => {
      const log = await run<{ text: string; truncated: boolean }>('dev.gitlab.checkLog', {
        pullRequestId: prId,
        checkId: completed.id,
      })
      // oxlint-disable-next-line no-control-regex -- asserting the host stripped terminal escapes
      if (/\u001b/.test(log.text)) throw new Error('dev.gitlab.checkLog returned terminal escapes')
      return `${completed.name}: ${log.text.length} chars${log.truncated ? ' (tail)' : ''}`
    })
  const labels = await run<{ items: unknown[] }>('dev.gitlab.labels', {
    repoId: REPO_ID,
    limit: 100,
  })
  record('dev.gitlab.labels', `${labels.items.length} labels`)
  const users = await run<{ items: unknown[] }>('dev.gitlab.assignableUsers', {
    repoId: REPO_ID,
    limit: 20,
  })
  record('dev.gitlab.assignableUsers', `${users.items.length} members`)
  const branches = await run<{ items: unknown[] }>('dev.gitlab.branches', {
    repoId: REPO_ID,
    limit: 100,
  })
  record('dev.gitlab.branches', `${branches.items.length} branches (first page)`)
  if (summary.headRef !== summary.baseRef) {
    try {
      const compare = await run<{ aheadBy: number; behindBy: number }>('dev.gitlab.compare', {
        repoId: REPO_ID,
        baseRef: repository.defaultBranch,
        headRef: summary.headRef,
      })
      record('dev.gitlab.compare', `${compare.aheadBy} ahead, ${compare.behindBy} behind`)
    } catch (error) {
      // A fork's source branch is not in the target project.
      record('dev.gitlab.compare', `typed refusal: ${(error as Error).message.slice(0, 100)}`)
    }
  }
  console.log(`\n${count} reads decoded strictly against ${repository.fullName}.`)
  process.exit(0)
} catch (error) {
  console.error(`FAILED: ${(error as Error).message}`)
  process.exit(1)
}
