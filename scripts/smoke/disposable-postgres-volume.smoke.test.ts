// Real-Docker no-leak proof for the disposable PostgreSQL proof container.
//
// The pinned image declares an anonymous data volume, so removing the proof
// container without its volumes would leave that volume behind on every run.
//
// This proof starts nothing that is not already local. The image is the
// repository's pinned one and every container is created with --pull=never, so
// no registry is contacted. It creates exactly two uniquely named containers
// and the anonymous volumes Docker gives them, removes the proof container
// with the proof's own removal command, and then proves that:
//
//   - the proof container's own anonymous volume is gone;
//   - an unrelated container's anonymous volume is still there;
//   - the unrelated container is still running.
//
// It never prunes, never removes a volume by name, and never touches a
// resource it did not create. It needs a Docker daemon and fails without one,
// because a skipped check is not a passing check. It sits outside
// scripts/*.test.ts, so the unit coverage lane never starts Docker.
//
//   python3 <fleet-heavy> -- bun test scripts/smoke/disposable-postgres-volume.smoke.test.ts

import { afterAll, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'

import { captureProvisioningImage } from '../capture-provisioning.mjs'
import {
  containerRemovalCommand,
  ownedAnonymousVolume,
  type ContainerMount,
} from '../disposable-postgres-ci'

const suffix = randomBytes(6).toString('hex')
const proofContainer = `adea-ci-volume-proof-${suffix}`
const sentinelContainer = `adea-ci-volume-sentinel-${suffix}`
const sentinelPassword = `synthetic-${randomBytes(12).toString('hex')}`

function docker(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  })
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function containerMounts(name: string): ContainerMount[] {
  const inspected = docker(['inspect', '--format', '{{json .Mounts}}', name])
  if (inspected.status !== 0) return []
  try {
    const parsed: unknown = JSON.parse(inspected.stdout.trim())
    return Array.isArray(parsed) ? (parsed as ContainerMount[]) : []
  } catch {
    return []
  }
}

function volumeExists(name: string): boolean {
  return docker(['volume', 'inspect', name]).status === 0
}

function containerExists(name: string): boolean {
  return docker(['inspect', name]).status === 0
}

function containerRunning(name: string): boolean {
  const inspected = docker(['inspect', '--format', '{{.State.Running}}', name])
  return inspected.status === 0 && inspected.stdout.trim() === 'true'
}

afterAll(() => {
  // Only the resources this proof created are removed here.
  docker(containerRemovalCommand(sentinelContainer))
  const sentinelVolume = ownedAnonymousVolume(containerMounts(sentinelContainer))
  if (sentinelVolume) docker(['volume', 'rm', sentinelVolume])
  docker(containerRemovalCommand(proofContainer))
})

test('removing the proof container removes only that container’s anonymous volume', () => {
  // The image must already be local: this proof never pulls it.
  const present = docker(['image', 'inspect', captureProvisioningImage])
  expect(present.status).toBe(0)
  expect(present.stdout).toContain(
    '77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873'
  )

  // The proof container and an unrelated sentinel, both from the local image.
  const created = docker([
    'create',
    '--name',
    proofContainer,
    '--pull=never',
    captureProvisioningImage,
  ])
  expect(created.status).toBe(0)
  const sentinel = docker([
    'create',
    '--name',
    sentinelContainer,
    '--pull=never',
    '-e',
    `POSTGRES_PASSWORD=${sentinelPassword}`,
    captureProvisioningImage,
  ])
  expect(sentinel.status).toBe(0)
  expect(docker(['start', sentinelContainer]).status).toBe(0)

  // The specific anonymous volume the proof container owns.
  const ownedVolume = ownedAnonymousVolume(containerMounts(proofContainer))
  expect(ownedVolume).toBeTruthy()
  const sentinelVolume = ownedAnonymousVolume(containerMounts(sentinelContainer))
  expect(sentinelVolume).toBeTruthy()
  expect(sentinelVolume).not.toBe(ownedVolume)
  expect(volumeExists(ownedVolume!)).toBe(true)
  expect(volumeExists(sentinelVolume!)).toBe(true)

  // The proof's own removal command: the container and the volumes attached to
  // it, and nothing else.
  const removed = docker(containerRemovalCommand(proofContainer))
  expect(removed.status).toBe(0)

  // The owned volume is gone.
  expect(containerExists(proofContainer)).toBe(false)
  expect(volumeExists(ownedVolume!)).toBe(false)
  // The unrelated volume and its container are untouched.
  expect(volumeExists(sentinelVolume!)).toBe(true)
  expect(containerRunning(sentinelContainer)).toBe(true)

  console.log(
    'DISPOSABLE_VOLUME_NO_LEAK ' +
      JSON.stringify({
        status: 'passed',
        ownedVolumeRemoved: true,
        unrelatedVolumeRemaining: true,
        unrelatedContainerRunning: true,
      })
  )
}, 900_000)
