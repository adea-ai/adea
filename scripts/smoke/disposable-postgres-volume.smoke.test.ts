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
// The owned container and volume identities are tracked before anything is
// deleted, so a container that is already gone does not take its volume's
// identity with it. The teardown attempts every owned resource, aggregates its
// failures, and confirms that every owned resource is gone; a teardown that
// cannot be confirmed fails the run instead of leaving the proof green. The
// final receipt is emitted only after that verified teardown.
//
// It never prunes, never removes a volume by a name it did not track, and
// never touches a resource it did not create. It needs a Docker daemon and
// fails without one, because a skipped check is not a passing check. It sits
// outside scripts/*.test.ts, so the unit coverage lane never starts Docker.
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
import {
  RESOURCE_STATE,
  classifyContainer,
  classifyVolume,
  cleanupOwnedResources,
  runBounded,
} from '../disposable-postgres-volume-cleanup.mjs'

const suffix = randomBytes(6).toString('hex')
const proofContainer = `adea-ci-volume-proof-${suffix}`
const sentinelContainer = `adea-ci-volume-sentinel-${suffix}`
const sentinelPassword = `synthetic-${randomBytes(12).toString('hex')}`

/**
 * The resources this proof owns.
 *
 * Every container name is registered before its create attempt, so a create
 * whose outcome is uncertain, or a later setup step that fails, still leaves
 * the teardown a name to remove. Every discovered volume is recorded the
 * moment it is discovered, for the same reason.
 */
const owned = { containers: [] as string[], volumes: [] as string[] }

/** Registers an owned container before it is created. */
function ownContainer(name: string): string {
  if (!owned.containers.includes(name)) owned.containers.push(name)
  return name
}

/** Registers an owned volume the moment it is discovered. */
function ownVolume(name: string): string {
  if (!owned.volumes.includes(name)) owned.volumes.push(name)
  return name
}

/** What the proof established, published only after the teardown is verified. */
let proofOutcome: Record<string, boolean> | undefined

function docker(args: string[]) {
  // A bounded child: a Docker call that outlives its bound is killed and
  // reported, so a hung call can never read as a completed one.
  return runBounded('docker', args, { spawnSync })
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

afterAll(() => {
  const outcome = cleanupOwnedResources({
    containers: owned.containers,
    volumes: owned.volumes,
    removeContainer: containerRemovalCommand,
    run: docker,
  })
  if (outcome.errors.length > 0) {
    throw new Error(
      `the disposable volume proof left owned resources: ${outcome.errors.join('; ')}`
    )
  }
  if (proofOutcome) {
    console.log(
      'DISPOSABLE_VOLUME_NO_LEAK ' +
        JSON.stringify({
          status: 'passed',
          ...proofOutcome,
          ownedResourcesRemoved: outcome.removed.length,
          ownedResourcesAbsent: outcome.absent.length,
        })
    )
  }
})

test('removing the proof container removes only that container’s anonymous volume', () => {
  // The image must already be local: this proof never pulls it.
  const present = docker(['image', 'inspect', captureProvisioningImage])
  expect(present.status).toBe(0)
  expect(present.stdout).toContain(
    '77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873'
  )

  // The proof container and an unrelated sentinel, both from the local image.
  // Each name is owned before its create attempt, so an uncertain create, or a
  // later setup step that fails, still leaves the teardown something to remove.
  ownContainer(proofContainer)
  const created = docker([
    'create',
    '--name',
    proofContainer,
    '--pull=never',
    captureProvisioningImage,
  ])
  expect(created.status).toBe(0)

  // The specific anonymous volume the proof container owns, recorded the
  // moment it is discovered.
  const ownedVolume = ownedAnonymousVolume(containerMounts(proofContainer))
  if (ownedVolume) ownVolume(ownedVolume)
  expect(ownedVolume).toBeTruthy()

  ownContainer(sentinelContainer)
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

  // The sentinel's own volume, recorded the moment it is discovered.
  const sentinelVolume = ownedAnonymousVolume(containerMounts(sentinelContainer))
  if (sentinelVolume) ownVolume(sentinelVolume)
  expect(sentinelVolume).toBeTruthy()
  expect(sentinelVolume).not.toBe(ownedVolume)
  expect(docker(['start', sentinelContainer]).status).toBe(0)

  // The proof's own removal command: the container and the volumes attached
  // to it, and nothing else.
  const removed = docker(containerRemovalCommand(proofContainer))
  expect(removed.status).toBe(0)

  // The owned volume is gone. A confirmed not-found is required: an inspect
  // that could not be read is not the same as a volume that is absent.
  expect(classifyContainer(docker, proofContainer)).toBe(RESOURCE_STATE.absent)
  expect(classifyVolume(docker, ownedVolume!)).toBe(RESOURCE_STATE.absent)
  // The unrelated volume and its container are untouched.
  expect(classifyVolume(docker, sentinelVolume!)).toBe(RESOURCE_STATE.present)
  const running = docker(['inspect', '--format', '{{.State.Running}}', sentinelContainer])
  expect(running.status).toBe(0)
  expect(running.stdout.trim()).toBe('true')

  proofOutcome = {
    ownedVolumeRemoved: true,
    unrelatedVolumeRemaining: true,
    unrelatedContainerRunning: true,
  }
}, 900_000)
