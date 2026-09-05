import { describe, expect, test } from 'bun:test'
import { prepareUpdateManifest } from './prepare-desktop-update-channel.mjs'

const signature = 'signed-update-payload'

function releaseManifest() {
  return {
    version: '0.3.4',
    notes: 'Private updater fix',
    pub_date: '2026-08-23T21:00:00Z',
    platforms: {
      'darwin-aarch64': {
        signature,
        url: 'https://api.github.com/repos/adea-ai/agent-hq/releases/assets/101',
      },
      'darwin-aarch64-app': {
        signature,
        url: 'https://api.github.com/repos/adea-ai/agent-hq/releases/assets/101',
      },
      'windows-x86_64': {
        signature,
        url: 'https://api.github.com/repos/adea-ai/agent-hq/releases/assets/202',
      },
    },
  }
}

const releaseAssets = [
  {
    id: 101,
    name: 'Agent.HQ_0.3.4_aarch64.app.tar.gz',
    url: 'https://api.github.com/repos/adea-ai/agent-hq/releases/assets/101',
  },
  {
    id: 202,
    name: 'Agent.HQ_0.3.4_x64-setup.exe',
    url: 'https://api.github.com/repos/adea-ai/agent-hq/releases/assets/202',
  },
]

describe('desktop update channel', () => {
  test('rewrites private release assets to one public signed channel', () => {
    const result = prepareUpdateManifest(
      releaseManifest(),
      releaseAssets,
      'https://adea-ai.github.io/agent-hq/desktop-updates/'
    )

    expect(result.assetNames).toEqual([
      'Agent.HQ_0.3.4_aarch64.app.tar.gz',
      'Agent.HQ_0.3.4_x64-setup.exe',
    ])
    expect(result.manifest.platforms['darwin-aarch64']).toEqual({
      signature,
      url: 'https://adea-ai.github.io/agent-hq/desktop-updates/Agent.HQ_0.3.4_aarch64.app.tar.gz',
    })
    expect(result.manifest.platforms['darwin-aarch64-app']).toEqual(
      result.manifest.platforms['darwin-aarch64']
    )
    expect(result.manifest.platforms['windows-x86_64'].url).toBe(
      'https://adea-ai.github.io/agent-hq/desktop-updates/Agent.HQ_0.3.4_x64-setup.exe'
    )
  })

  test('rejects an update package missing from the release asset inventory', () => {
    expect(() =>
      prepareUpdateManifest(releaseManifest(), releaseAssets.slice(0, 1), 'https://example.com/')
    ).toThrow('release asset 202')
  })

  test('rejects unsafe channel URLs and unsigned platform entries', () => {
    expect(() =>
      prepareUpdateManifest(releaseManifest(), releaseAssets, 'http://example.com/updates')
    ).toThrow('HTTPS')

    const manifest = releaseManifest()
    manifest.platforms['darwin-aarch64'].signature = ''
    expect(() => prepareUpdateManifest(manifest, releaseAssets, 'https://example.com/')).toThrow(
      'signature'
    )
  })
})
