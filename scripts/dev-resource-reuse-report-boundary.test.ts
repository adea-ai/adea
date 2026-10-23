import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { REUSE_DECISION, REUSE_REFUSAL } from './dev-resource-reuse.mjs'
import {
  dockerResourceInventory,
  ignoredContent,
  isFutureLease,
  main,
  physicalWorktreePath,
  planWorktrees,
  proofForIgnoredPath,
  remoteBranchHeads,
  worktreesOf,
} from './dev-resource-reuse-report.mjs'

const scratch: string[] = []
let dockerSequence = 0

function tempDirectory(name: string) {
  const path = mkdtempSync(join(tmpdir(), `adea-report-boundary-${name}-`))
  scratch.push(path)
  return path
}

function git(args: string[], cwd: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
}

function plainRepo(root: string) {
  const repo = join(root, 'repo')
  mkdirSync(repo)
  git(['init', '--initial-branch=main'], repo)
  git(['config', 'user.email', 'report-boundary@example.invalid'], repo)
  git(['config', 'user.name', 'Report boundary test'], repo)
  writeFileSync(join(repo, 'tracked.txt'), 'tracked\n')
  git(['add', '.'], repo)
  git(['commit', '-m', 'fixture'], repo)
  return repo
}

function fakeDocker(root: string, body: string) {
  const bin = join(root, `bin-${dockerSequence++}`)
  mkdirSync(bin)
  const executable = join(bin, 'docker')
  writeFileSync(executable, `#!/bin/sh\n${body}\n`)
  chmodSync(executable, 0o755)
  return `${bin}:${process.env.PATH ?? ''}`
}

function invokeMain(options: Parameters<typeof main>[0]) {
  const previousExitCode = process.exitCode
  let output = ''
  let written: { path: string; report: Record<string, any> } | null = null
  process.exitCode = 0
  try {
    main({
      ...options,
      writeReport: (path, content) => {
        written = { path, report: JSON.parse(content) }
      },
      writeOutput: (text) => {
        output += text
      },
    })
    return { exitCode: process.exitCode, output, written }
  } finally {
    process.exitCode = previousExitCode ?? 0
  }
}

afterAll(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('resource report command boundaries', () => {
  test('Docker inventories parse labelled and unlabelled containers and volumes', () => {
    const calls: string[][] = []
    const inventory = dockerResourceInventory((_command, args) => {
      calls.push(args)
      return args[0] === 'ps'
        ? { status: 0, stdout: 'api\tadea\norphan\n\n', stderr: '' }
        : { status: 0, stdout: 'data\tadea\n', stderr: '' }
    })

    expect(inventory.resources).toEqual([
      { kind: 'container', name: 'api', label: 'adea' },
      { kind: 'container', name: 'orphan', label: null },
      { kind: 'volume', name: 'data', label: 'adea' },
    ])
    expect(inventory.errors).toEqual([])
    expect(calls.map((args) => args[0])).toEqual(['ps', 'volume'])
  })

  test('Docker listing failures remain inventory errors instead of empty success', () => {
    const inventory = dockerResourceInventory((_command, args) =>
      args[0] === 'ps'
        ? { status: 2, stdout: '', stderr: 'daemon unavailable' }
        : { error: new Error('socket unavailable'), status: null, stdout: '', stderr: '' }
    )

    expect(inventory.resources).toEqual([])
    expect(inventory.errors).toEqual([
      { source: 'docker containers', reason: 'daemon unavailable' },
      { source: 'docker volumes', reason: 'socket unavailable' },
    ])
    const fallback = dockerResourceInventory(() => ({ status: 1, stdout: '', stderr: '' }))
    expect(fallback.errors.map(({ reason }) => reason)).toEqual([
      'Docker listing failed',
      'Docker listing failed',
    ])
  })

  test('ignored content handles files, symlinks, missing paths, and size limits fail-closed', () => {
    const root = tempDirectory('ignored')
    const file = join(root, 'single.txt')
    writeFileSync(file, 'bytes')
    expect(ignoredContent(root, 'single.txt')).toMatchObject({
      files: 1,
      bytes: 5,
      truncated: false,
    })

    const directory = join(root, 'tree')
    mkdirSync(directory)
    writeFileSync(join(directory, 'one.txt'), '1234')
    const nested = join(directory, 'nested')
    mkdirSync(nested)
    writeFileSync(join(nested, 'two.txt'), 'xy')
    symlinkSync('one.txt', join(directory, 'alias'))
    expect(ignoredContent(root, 'tree')).toMatchObject({ files: 3, bytes: 6, truncated: false })
    symlinkSync('single.txt', join(root, 'root-link'))
    expect(ignoredContent(root, 'root-link').truncated).toBe(true)
    expect(ignoredContent(root, 'tree', { fileLimit: 1 }).truncated).toBe(true)
    expect(ignoredContent(root, 'tree', { byteLimit: 3 }).truncated).toBe(true)
    expect(ignoredContent(root, 'missing')).toMatchObject({ files: 0, bytes: 0, truncated: true })
    expect(physicalWorktreePath('relative/path')).toBeNull()
    expect(physicalWorktreePath(join(root, 'missing'))).toBeNull()
  })

  test('ignored content read failures are truncated rather than counted as empty', () => {
    const root = tempDirectory('ignored-read-errors')
    const directory = join(root, 'tree')
    mkdirSync(directory)
    const file = join(directory, 'data.txt')
    writeFileSync(file, 'private')
    const link = join(directory, 'link')
    symlinkSync('data.txt', link)

    const failedDirectoryRead = ignoredContent(
      root,
      'tree',
      {},
      {
        readdirSync: () => {
          throw new Error('directory unreadable')
        },
      }
    )
    expect(failedDirectoryRead).toMatchObject({ files: 0, truncated: true })
    expect(proofForIgnoredPath('tree', { content: failedDirectoryRead })).toBeNull()

    const failedEntryStat = ignoredContent(
      root,
      'tree',
      {},
      {
        lstatSync: (path: string) => {
          if (path === file) throw new Error('entry disappeared')
          return lstatSync(path)
        },
      }
    )
    expect(failedEntryStat.truncated).toBe(true)
    expect(proofForIgnoredPath('tree', { content: failedEntryStat })).toBeNull()

    const failedLinkRead = ignoredContent(
      root,
      'tree',
      {},
      {
        readlinkSync: () => {
          throw new Error('link unreadable')
        },
      }
    )
    expect(failedLinkRead.truncated).toBe(true)
    expect(proofForIgnoredPath('tree', { content: failedLinkRead })).toBeNull()

    const failedContentRead = ignoredContent(
      root,
      'tree',
      {},
      {
        readFileSync: () => {
          throw new Error('file unreadable')
        },
      }
    )
    expect(failedContentRead.truncated).toBe(true)
    expect(proofForIgnoredPath('tree', { content: failedContentRead })).toBeNull()

    writeFileSync(join(root, 'single.txt'), 'private')
    const failedSingleFileRead = ignoredContent(
      root,
      'single.txt',
      {},
      {
        readFileSync: () => {
          throw new Error('file unreadable')
        },
      }
    )
    expect(failedSingleFileRead).toMatchObject({ files: 0, truncated: true })
    expect(proofForIgnoredPath('single.txt', { content: failedSingleFileRead })).toBeNull()
  })

  test('remote head parsing ignores malformed and non-branch refs, and command errors are unknown', () => {
    const heads = remoteBranchHeads('/repo', () => ({
      status: 0,
      stdout: [
        'abc\trefs/heads/main',
        'malformed',
        'def\trefs/tags/v1',
        '\trefs/heads/empty-sha',
      ].join('\n'),
      stderr: '',
    }))
    expect([...heads.entries()]).toEqual([['main', 'abc']])
    expect(
      remoteBranchHeads('/repo', () => ({ status: 1, stdout: '', stderr: 'offline' }))
    ).toBeNull()
  })

  test('invalid repository and worktree-list errors are reported, not treated as empty inventories', () => {
    expect(worktreesOf('relative/repo').inventoryError).toMatchObject({
      source: 'git worktree list',
      reason: 'the repository path could not be resolved',
    })

    const root = tempDirectory('git-list-error')
    const repo = join(root, 'repo')
    mkdirSync(repo)
    const result = worktreesOf(repo, {
      runCommand: () => ({
        error: new Error('git unavailable'),
        status: null,
        stdout: '',
        stderr: '',
      }),
    })
    expect(result.worktrees).toEqual([])
    expect(result.inventoryError).toMatchObject({
      source: 'git worktree list',
      reason: 'the worktree inventory could not be read',
    })
  })

  test('detached worktree records stay unpublished when no branch can be bound', () => {
    const root = tempDirectory('detached')
    const repo = join(root, 'repo')
    const checkout = join(root, 'checkout')
    mkdirSync(repo)
    mkdirSync(checkout)
    const result = worktreesOf(repo, {
      runCommand: (_command, args) => {
        if (args[0] === 'worktree') {
          return {
            status: 0,
            stdout: `worktree ${repo}\nHEAD root\n\nworktree ${checkout}\nHEAD abc\ndetached\n`,
            stderr: '',
          }
        }
        return { status: 0, stdout: '', stderr: '' }
      },
    })

    expect(result.worktrees).toHaveLength(1)
    expect(result.worktrees[0]).toMatchObject({
      path: checkout,
      head: 'abc',
      branch: null,
      published: false,
      origin: { fresh: false, containsHead: false, remoteBranchPresent: false, bound: false },
    })
  })

  test('fetch failures retain their reason and unresolved path resolvers refuse reuse', () => {
    const root = tempDirectory('fetch-failure')
    const fetchError = worktreesOf(root, {
      refresh: true,
      runCommand: (_command, args) =>
        args[0] === 'fetch'
          ? { error: new Error('fetch process missing'), status: null, stdout: '', stderr: '' }
          : { status: 0, stdout: '', stderr: '' },
    })
    expect(fetchError.fetch).toMatchObject({
      requested: true,
      ok: false,
      error: 'fetch process missing',
    })

    const fetchStatus = worktreesOf(root, {
      refresh: true,
      runCommand: (_command, args) =>
        args[0] === 'fetch'
          ? { status: 1, stdout: 'fetch output', stderr: '' }
          : { status: 0, stdout: '', stderr: '' },
    })
    expect(fetchStatus.fetch.error).toBe('fetch output')
    const noFetchOutput = worktreesOf(root, {
      refresh: true,
      runCommand: (_command, args) =>
        args[0] === 'fetch'
          ? { status: 1, stdout: '', stderr: '' }
          : { status: 0, stdout: '', stderr: '' },
    })
    expect(noFetchOutput.fetch.error).toBe('the fetch failed')

    const lease = {
      runId: 'run-unknown-path',
      identity: { worktree: '/unresolvable/checkout' },
    }
    const [planned] = planWorktrees(
      [
        {
          path: '/unresolvable/checkout',
          head: 'abc',
          localChanges: false,
          ignoredUnknown: [],
          origin: { fresh: true, containsHead: true },
        },
      ],
      [lease],
      {
        physicalPathOf: () => {
          throw new Error('realpath failed')
        },
      }
    )
    expect(planned?.plan.decision).toBe(REUSE_DECISION.refuse)
    expect(planned?.plan.reasons).toContain(REUSE_REFUSAL.uncertain)
    expect(isFutureLease({ createdAt: 0, updatedAt: 'not-a-time' }, 0)).toBe(false)
  })

  test('CLI exits nonzero and writes the failure evidence for Docker, lease, and fetch errors', () => {
    const root = tempDirectory('cli-errors')
    const repo = plainRepo(root)
    const leases = join(root, 'leases')
    mkdirSync(leases)
    const reportPath = join(root, 'docker-report.json')
    const dockerPath = fakeDocker(root, 'exit 7')
    const reportScript = join(import.meta.dir, 'dev-resource-reuse-report.mjs')
    const dockerResult = spawnSync(
      process.execPath,
      [reportScript, '--repo', repo, '--lease-dir', leases, '--report', reportPath],
      { encoding: 'utf8', env: { ...process.env, PATH: dockerPath } }
    )
    const dockerReport = JSON.parse(readFileSync(reportPath, 'utf8'))
    expect(dockerResult.status).toBe(1)
    expect(dockerReport.inventoryComplete).toBe(false)
    expect(dockerReport.preservation.ok).toBe(false)
    expect(dockerReport.inventoryErrors.map(({ source }) => source)).toEqual([
      'docker containers',
      'docker volumes',
    ])

    const badLeasePath = join(root, 'not-a-directory')
    writeFileSync(badLeasePath, 'not a directory\n')
    const emptyDockerPath = fakeDocker(root, 'exit 0')
    const leaseResult = spawnSync(
      process.execPath,
      [reportScript, '--repo', repo, '--lease-dir', badLeasePath],
      { encoding: 'utf8', env: { ...process.env, PATH: emptyDockerPath } }
    )
    const leaseReport = JSON.parse(leaseResult.stdout)
    expect(leaseResult.status).toBe(1)
    expect(leaseReport.leaseScanError).toContain('not a directory')

    const fetchResult = spawnSync(
      process.execPath,
      [reportScript, '--repo', repo, '--lease-dir', leases, '--fetch'],
      { encoding: 'utf8', env: { ...process.env, PATH: emptyDockerPath } }
    )
    const fetchReport = JSON.parse(fetchResult.stdout)
    expect(fetchResult.status).toBe(1)
    expect(fetchReport.fetchRequested).toBe(true)
    expect(fetchReport.fetchError).not.toBeNull()
    expect(fetchReport.originRefreshed).toBe(false)
  })

  test('main reports each incomplete read and sets a failing exit status', () => {
    const root = tempDirectory('main-errors')
    const leases = join(root, 'leases')
    mkdirSync(leases)
    const reportPath = join(root, 'report.json')
    const dockerFailure = invokeMain({
      argv: ['--report', reportPath, '--lease-dir', leases],
      runCommand: () => ({ status: 1, stdout: '', stderr: 'Docker unavailable' }),
    })
    expect(dockerFailure.exitCode).toBe(1)
    expect(dockerFailure.written?.path).toBe(reportPath)
    expect(dockerFailure.written?.report.inventoryComplete).toBe(false)
    expect(dockerFailure.written?.report.preservation.ok).toBe(false)
    expect(dockerFailure.output).toContain(`wrote ${reportPath}`)

    const badLeasePath = join(root, 'not-a-directory')
    writeFileSync(badLeasePath, 'not a directory\n')
    const leaseFailure = invokeMain({
      argv: ['--lease-dir', badLeasePath],
      runCommand: () => ({ status: 0, stdout: '', stderr: '' }),
    })
    expect(leaseFailure.exitCode).toBe(1)
    expect(JSON.parse(leaseFailure.output).leaseScanError).not.toBeNull()

    const repo = plainRepo(root)
    const fetchFailure = invokeMain({
      argv: ['--repo', repo, '--lease-dir', leases, '--fetch'],
      runCommand: (_command, args) =>
        args[0] === 'fetch'
          ? { status: 1, stdout: '', stderr: 'origin unavailable' }
          : { status: 0, stdout: '', stderr: '' },
    })
    const report = JSON.parse(fetchFailure.output)
    expect(fetchFailure.exitCode).toBe(1)
    expect(report.fetchRequested).toBe(true)
    expect(report.fetchError).toBe('origin unavailable')
    expect(report.originRefreshed).toBe(false)
  })
})
