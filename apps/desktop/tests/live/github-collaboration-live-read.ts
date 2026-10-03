// Source control app — GitHub collaboration live READ pass (opt-in evidence).
//
// The fixture suite (tests/dev-runtime-github-collaboration.test.ts) proves
// the handlers against a scripted gh. This lane runs the same signed-channel
// construction with the PRODUCTION gh transport against a real repository,
// read-only: no comment, review, merge, branch update, or label change is
// ever sent. Every reply is re-decoded through the strict client decoders,
// so a GraphQL field GitHub does not serve, or a mapping that drifts from the
// contract, fails here.
//
// Usage:
//   bun apps/desktop/tests/live/github-collaboration-live-read.ts \
//     [--root <checkout with a github.com origin>] [--pr <number>]
//
// Exit code 0 only when every read decoded.
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
import { registerGithubRuntime } from '../../shell/src/dev-runtime/github/register'

function argOf(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const ROOT = realpathSync(argOf('--root') ?? process.cwd())
const REPO_ID = '00000000-0000-4000-8000-000000005301'
const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

const authority = createChannelAuthority({
  shellHost: '127.0.0.1',
  shellOrigin: 'https://127.0.0.1:4789',
})
const repo = { repoId: REPO_ID, canonicalRoot: ROOT }
// runGh intentionally omitted: the production gh transport.
registerGithubRuntime({
  authority,
  scope,
  dataDir: mkdtempSync(join(tmpdir(), 'adea-gh-collab-live-')),
  resolveRepo: (repoId) => (repoId === REPO_ID ? repo : undefined),
  listRepos: () => [repo],
  resolveWorktree: () => undefined,
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
const results: { operation: string; detail: string }[] = []
const record = (operation: string, detail: string) => {
  results.push({ operation, detail })
  console.log(`ok  ${operation.padEnd(34)} ${detail}`)
}

try {
  const account = await run<{ login: string }>('dev.github.account', {})
  record('dev.github.account', `signed in as ${account.login}`)
  const repository = await run<{
    fullName: string
    defaultBranch: string
    defaultBranchHead?: { sha: string; checks: string }
  }>('dev.github.repository', { repoId: REPO_ID, refresh: true })
  record(
    'dev.github.repository',
    `${repository.fullName}, default ${repository.defaultBranch}, CI ${repository.defaultBranchHead?.checks ?? 'unknown'}`
  )
  const open = await run<{ items: Summary[]; nextCursor?: string }>(
    'dev.github.pullRequestSummaries',
    {
      repoId: REPO_ID,
      state: 'open',
      limit: 25,
    }
  )
  record(
    'dev.github.pullRequestSummaries',
    `${open.items.length} open${open.nextCursor ? ' (more pages)' : ''}`
  )
  const merged = await run<{ items: Summary[] }>('dev.github.pullRequestSummaries', {
    repoId: REPO_ID,
    state: 'merged',
    limit: 10,
  })
  record('dev.github.pullRequestSummaries', `${merged.items.length} merged (first page)`)

  const wanted = argOf('--pr')
  const target =
    (wanted
      ? [...open.items, ...merged.items].find((pr) => pr.number === Number(wanted))
      : undefined) ??
    open.items[0] ??
    merged.items[0]
  if (!target) throw new Error('the repository has no pull requests to read')
  const prId = target.id
  const summary = await run<
    Summary & { behindBy?: number; checks: { state: string; total: number } }
  >('dev.github.pullRequestSummary', { pullRequestId: prId, refresh: true })
  record(
    'dev.github.pullRequestSummary',
    `#${summary.number} ${summary.title.slice(0, 50)} (checks ${summary.checks.state}/${summary.checks.total}, behind ${summary.behindBy ?? '?'})`
  )
  const timeline = await run<{ items: { kind: string }[] }>('dev.github.timeline', {
    pullRequestId: prId,
    limit: 100,
  })
  const kinds = timeline.items.reduce<Record<string, number>>((acc, item) => {
    acc[item.kind] = (acc[item.kind] ?? 0) + 1
    return acc
  }, {})
  record('dev.github.timeline', JSON.stringify(kinds))
  const commits = await run<{ items: { sha: string }[] }>('dev.github.commits', {
    pullRequestId: prId,
    limit: 100,
  })
  record('dev.github.commits', `${commits.items.length} commits`)
  const files = await run<{ items: { path: string; patchTruncated: boolean }[] }>(
    'dev.github.files',
    {
      pullRequestId: prId,
      limit: 100,
    }
  )
  record('dev.github.files', `${files.items.length} files`)
  const checks = await run<{
    items: { id: string; name: string; status: string; conclusion?: string }[]
  }>('dev.github.checks', { pullRequestId: prId, sha: summary.headSha, limit: 100 })
  record('dev.github.checks', `${checks.items.length} check runs on ${summary.headSha.slice(0, 7)}`)
  const completed = checks.items.find((check) => check.status === 'completed')
  if (completed) {
    try {
      const log = await run<{ text: string; truncated: boolean }>('dev.github.checkLog', {
        pullRequestId: prId,
        checkId: completed.id,
      })
      // oxlint-disable-next-line no-control-regex -- asserting the host stripped terminal escapes
      if (/\u001b/.test(log.text)) throw new Error('dev.github.checkLog returned terminal escapes')
      record(
        'dev.github.checkLog',
        `${completed.name}: ${log.text.length} chars${log.truncated ? ' (tail)' : ''}`
      )
    } catch (error) {
      // Logs expire and third-party checks have none: a typed refusal is the contract.
      record('dev.github.checkLog', `typed refusal: ${(error as Error).message.slice(0, 100)}`)
    }
  }
  const labels = await run<{ items: unknown[] }>('dev.github.labels', {
    repoId: REPO_ID,
    limit: 100,
  })
  record('dev.github.labels', `${labels.items.length} labels`)
  const users = await run<{ items: unknown[] }>('dev.github.assignableUsers', {
    repoId: REPO_ID,
    limit: 20,
  })
  record('dev.github.assignableUsers', `${users.items.length} users`)
  const branches = await run<{ items: unknown[] }>('dev.github.branches', {
    repoId: REPO_ID,
    limit: 100,
  })
  record('dev.github.branches', `${branches.items.length} branches (first page)`)
  if (summary.headRef !== summary.baseRef) {
    try {
      const compare = await run<{ aheadBy: number; behindBy: number }>('dev.github.compare', {
        repoId: REPO_ID,
        baseRef: repository.defaultBranch,
        headRef: summary.headRef,
      })
      record('dev.github.compare', `${compare.aheadBy} ahead, ${compare.behindBy} behind`)
    } catch (error) {
      record('dev.github.compare', `typed refusal: ${(error as Error).message.slice(0, 100)}`)
    }
  }
  console.log(`\n${results.length} reads decoded strictly against ${repository.fullName}.`)
  process.exit(0)
} catch (error) {
  console.error(`FAILED: ${(error as Error).message}`)
  process.exit(1)
}
