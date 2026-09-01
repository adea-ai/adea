import { describe, expect, test } from 'bun:test'

import type { AgentHqApiClient } from '@agent-hq/api-client'

import {
  canonicalDigest,
  canonicalJson,
  mapRegistryCatalog,
  verifyRegistryArtifacts,
} from '../../src/marketplace-catalog'
import {
  createRegistryPluginsProvider,
  defaultPluginFilter,
  filterWorkspacePlugins,
  getPopularWorkspacePlugins,
  groupWorkspacePlugins,
  popularWorkspacePluginIds,
  workspacePluginCategoryOrder,
} from '../../src/plugins'
import type { RegistryArtifactBundle, RegistryCatalog } from '../../src/marketplace-catalog'

async function fixtureArtifacts(): Promise<{
  artifacts: RegistryArtifactBundle
  catalog: RegistryCatalog
}> {
  const release = {
    capabilities: [
      {
        metadata: {},
        name: 'Read mail',
        paths: ['gmail.search'],
        securityImpact: 'low',
        type: 'connector',
      },
    ],
    canonicalContentDigest: `sha256:${'b'.repeat(64)}`,
    contentResolution: 'complete' as const,
    releaseId: `release:${'c'.repeat(64)}`,
    releaseMetadata: { publishedAt: '2026-08-31T00:00:00.000Z' },
    requiredConnectors: ['gmail'],
    requiredCredentials: ['google.oauth'],
    resolvedCommitSha: 'a'.repeat(40),
  }
  const plugin = {
    authors: ['OpenAI'],
    availableReleases: [release],
    capabilitySummary: { connector: 1 },
    categories: ['productivity'],
    currentReleaseId: release.releaseId,
    description: 'Search mail.',
    displayName: 'Gmail',
    harnessCompatibility: { codex: 'supported' },
    homepage: 'https://example.com/gmail',
    icons: ['https://example.com/gmail.svg'],
    keywords: ['mail', 'schedule'],
    license: { name: 'Apache-2.0' },
    pluginId: 'plugin:openai-official:gmail',
    productGroupingKey: 'gmail',
    provenance: {
      repositoryUrl: 'https://github.com/openai/plugins',
      resolvedCommitSha: 'a'.repeat(40),
    },
    securityClassification: { level: 'standard' },
    sourceId: 'openai-official',
  }
  const body = {
    generatedAt: '2026-08-31T00:00:00.000Z',
    plugins: [plugin],
    schemaVersion: 1 as const,
    sources: [{ sourceId: 'openai-official' }],
  }
  const catalogId = `catalog:${(await canonicalDigest(body)).slice('sha256:'.length)}`
  const catalog = { ...body, catalogId }
  const catalogText = JSON.stringify(catalog)
  const summaryText = JSON.stringify({
    catalogId,
    generatedAt: body.generatedAt,
    pluginCount: 1,
    schemaVersion: 1,
  })
  const categoriesText = JSON.stringify({
    categories: ['productivity'],
    catalogId,
    schemaVersion: 1,
  })
  const compatibilityText = JSON.stringify({ catalogId, plugins: [], schemaVersion: 1 })
  const lockText = JSON.stringify({ catalogId, schemaVersion: 1, sources: [] })
  const files = {
    'catalog-summary.v1.json': summaryText,
    'catalog.v1.json': catalogText,
    'categories.v1.json': categoriesText,
    'compatibility.v1.json': compatibilityText,
    'sources.lock.json': lockText,
  }
  const integrityFiles: Record<string, string> = {}
  for (const [name, text] of Object.entries(files))
    integrityFiles[name] = await canonicalDigest(text)
  const integrityText = JSON.stringify({ catalogId, files: integrityFiles, schemaVersion: 1 })
  return {
    artifacts: {
      'catalog-latest.v1.json': catalogText,
      'catalog-summary.v1.json': summaryText,
      'catalog.v1.json': catalogText,
      'categories.v1.json': categoriesText,
      'compatibility.v1.json': compatibilityText,
      'integrity.json': integrityText,
      'sources.lock.json': lockText,
    },
    catalog,
  }
}

describe('registry marketplace catalog', () => {
  test('replicates canonical JSON and verifies every catalog artifact', async () => {
    expect(canonicalJson({ z: 1, a: [2, { b: true, a: null }] })).toBe(
      '{"a":[2,{"a":null,"b":true}],"z":1}'
    )
    const fixture = await fixtureArtifacts()
    const verified = await verifyRegistryArtifacts(fixture.artifacts)
    expect(verified.catalog.catalogId).toBe(fixture.catalog.catalogId)
    expect(verified.releaseId).toBe(fixture.catalog.catalogId)
  })

  test('rejects a tampered artifact and a non-identical latest pointer', async () => {
    const fixture = await fixtureArtifacts()
    await expect(
      verifyRegistryArtifacts({
        ...fixture.artifacts,
        'catalog.v1.json': `${fixture.artifacts['catalog.v1.json']}\n`,
      })
    ).rejects.toThrow('digest mismatch')
    await expect(
      verifyRegistryArtifacts({ ...fixture.artifacts, 'catalog-latest.v1.json': '{}' })
    ).rejects.toThrow('byte-identical')
  })

  test('maps source-qualified plugin IDs and preserves registry release metadata', async () => {
    const fixture = await fixtureArtifacts()
    const [plugin] = mapRegistryCatalog(fixture.catalog, [])
    expect(plugin).toMatchObject({
      canonicalContentDigest: `sha256:${'b'.repeat(64)}`,
      id: 'plugin:openai-official:gmail',
      pluginId: 'plugin:openai-official:gmail',
      releaseId: `release:${'c'.repeat(64)}`,
      sourceId: 'openai-official',
      sourceRevision: 'a'.repeat(40),
    })
    expect(plugin.icons).toEqual(['https://example.com/gmail.svg'])
    expect(plugin.requiredConnectors).toEqual(['gmail'])
    expect(plugin.requiredCredentials).toEqual(['google.oauth'])
  })

  test('loads the registry through the provider and submits the exact release request', async () => {
    const fixture = await fixtureArtifacts()
    const requests: unknown[] = []
    const client = {
      getMarketplaceCatalog: async () => ({
        artifacts: fixture.artifacts,
        catalogId: fixture.catalog.catalogId,
        installations: [],
        releaseId: fixture.catalog.catalogId,
      }),
      requestMarketplaceInstall: async (_workspaceId: string, input: unknown) => {
        requests.push(input)
        return {
          canonicalContentDigest: `sha256:${'b'.repeat(64)}`,
          installationId: 'installation-1',
          message: 'pending authorization',
          releaseId: `release:${'c'.repeat(64)}`,
          state: 'pending-authorization' as const,
        }
      },
    } as unknown as AgentHqApiClient
    const provider = createRegistryPluginsProvider({
      client,
      getWorkspaceId: () => 'workspace-1',
      getUserId: () => 'user-1',
      requestedHarness: 'codex',
    })
    const plugins = await provider.list()
    expect(filterWorkspacePlugins(plugins, 'yours', '')).toEqual([])
    const after = await provider.requestInstall('plugin:openai-official:gmail')
    expect(requests).toEqual([
      {
        canonicalContentDigest: `sha256:${'b'.repeat(64)}`,
        idempotencyKey: `marketplace:plugin:openai-official:gmail:release:${'c'.repeat(64)}`,
        pluginId: 'plugin:openai-official:gmail',
        releaseId: `release:${'c'.repeat(64)}`,
        requestedHarness: 'codex',
        workspaceIdentity: { userId: 'user-1', workspaceId: 'workspace-1' },
      },
    ])
    expect(after[0]?.installationStatus).toBe('pending-authorization')
    expect(filterWorkspacePlugins(after, 'yours', '').map(({ id }) => id)).toEqual([])
  })

  test('keeps Popular first and retains grouped previews for dynamic catalog categories', async () => {
    const fixture = await fixtureArtifacts()
    const plugins = mapRegistryCatalog(fixture.catalog, [])
    expect(getPopularWorkspacePlugins(plugins).map(({ id }) => id)).toEqual([
      'plugin:openai-official:gmail',
    ])
    expect(popularWorkspacePluginIds[0]).toBe('plugin:openai-official:gmail')
    expect(groupWorkspacePlugins(plugins).map(({ category }) => category)).toEqual(['Productivity'])
    expect(workspacePluginCategoryOrder).toContain('Productivity')
    expect(
      filterWorkspacePlugins(plugins, 'marketplace', 'schedule', {
        ...defaultPluginFilter,
      }).map(({ id }) => id)
    ).toEqual(['plugin:openai-official:gmail'])
  })
})
