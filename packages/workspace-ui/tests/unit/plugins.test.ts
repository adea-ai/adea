import { describe, expect, setSystemTime, test } from 'bun:test'
import { pluginBrandIconUrl, pluginIconUrl } from '../../src/marketplace-catalog'

import type { AgentHqApiClient } from '@adea-ai/api-client'

import {
  canonicalDigest,
  canonicalJson,
  compiledBrandMarks,
  loadBrowsingCatalog,
  mapRegistryCatalog,
  navigationCatalogIndexUrl,
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

async function fixtureArtifacts(options: { catalogIndexUrl?: string } = {}): Promise<{
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
    ...(options.catalogIndexUrl === undefined ? {} : { catalogIndexUrl: options.catalogIndexUrl }),
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

function installInMemoryStorage(): { restore: () => void } {
  const values = new Map<string, string>()
  const previous = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => void values.delete(key),
      setItem: (key: string, value: string) => void values.set(key, value),
    },
  }
  return {
    restore: () => {
      ;(globalThis as { window?: unknown }).window = previous
    },
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

  test('accepts a release that also publishes consumer shards and brand marks', async () => {
    const fixture = await fixtureArtifacts()
    const catalogId = fixture.catalog.catalogId
    const extra = {
      'catalog-index.v1.json': JSON.stringify({ catalogId, products: {}, schemaVersion: 1 }),
      'icon-0123456789abcdef0123456789abcdef.png': 'binary',
    }
    const declared: Record<string, string> = {}
    for (const name of [
      'catalog.v1.json',
      'catalog-summary.v1.json',
      'categories.v1.json',
      'compatibility.v1.json',
      'sources.lock.json',
    ])
      declared[name] = (
        JSON.parse(fixture.artifacts['integrity.json']) as { files: Record<string, string> }
      ).files[name]!
    declared['catalog-index.v1.json'] = await canonicalDigest(extra['catalog-index.v1.json'])
    declared['shelf-productivity.v1.json'] = await canonicalDigest(
      extra['shelf-productivity.v1.json']
    )
    declared['icon-0123456789abcdef0123456789abcdef.png'] = await canonicalDigest(
      extra['icon-0123456789abcdef0123456789abcdef.png']
    )
    const verified = await verifyRegistryArtifacts({
      ...fixture.artifacts,
      ...extra,
      'integrity.json': JSON.stringify({
        assets: [],
        catalogId,
        files: declared,
        schemaVersion: 1,
      }),
    })
    expect(verified.catalog.catalogId).toBe(catalogId)
  })

  test('rejects a manifest that omits a required artifact', async () => {
    const fixture = await fixtureArtifacts()
    const integrity = JSON.parse(fixture.artifacts['integrity.json']) as {
      files: Record<string, string>
    }
    const files = { ...integrity.files }
    delete files['categories.v1.json']
    await expect(
      verifyRegistryArtifacts({
        ...fixture.artifacts,
        'integrity.json': JSON.stringify({
          catalogId: fixture.catalog.catalogId,
          files,
          schemaVersion: 1,
        }),
      })
    ).rejects.toThrow('integrity metadata is invalid')
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

  test('surfaces canonical Agent Plugins package status without treating it as approval', async () => {
    const fixture = await fixtureArtifacts()
    const release = fixture.catalog.plugins[0]!.availableReleases[0]!
    const catalog = {
      ...fixture.catalog,
      plugins: [
        {
          ...fixture.catalog.plugins[0]!,
          availableReleases: [
            {
              ...release,
              releaseMetadata: {
                ...release.releaseMetadata,
                agentPlugins: {
                  packageDigest: `sha256:${'d'.repeat(64)}`,
                  status: 'partial',
                },
              },
            },
          ],
        },
      ],
    }
    const [plugin] = mapRegistryCatalog(catalog, [])
    expect(plugin).toMatchObject({
      agentPluginsStatus: 'partial',
      installationPolicy: 'available',
      packageDigest: `sha256:${'d'.repeat(64)}`,
    })
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
        state: 'ready' as const,
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
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      canonicalContentDigest: `sha256:${'b'.repeat(64)}`,
      pluginId: 'plugin:openai-official:gmail',
      releaseId: `release:${'c'.repeat(64)}`,
      requestedHarness: 'codex',
      installationInstanceId: expect.stringMatching(/^marketplace:[a-f0-9]{64}$/u),
      workspaceIdentity: { userId: 'user-1', workspaceId: 'workspace-1' },
    })
    expect((requests[0] as { idempotencyKey: string }).idempotencyKey).toMatch(
      /^marketplace:[a-f0-9]{64}$/u
    )
    expect(after[0]?.installationStatus).toBe('pending-authorization')
    expect(filterWorkspacePlugins(after, 'yours', '').map(({ id }) => id)).toEqual([])
  })

  test('skips the full read when the published index reports the identity already held', async () => {
    // A catalog release is immutable and a new one only appears under a new
    // catalogId, so the index — a megabyte or so — answers "was anything
    // published?" without re-reading tens of megabytes every refresh.
    const indexUrl = 'https://cdn.example/catalog-index.json'
    const fixture = await fixtureArtifacts({ catalogIndexUrl: indexUrl })
    const catalogId = fixture.catalog.catalogId
    const storage = installInMemoryStorage()
    const previousFetch = globalThis.fetch
    try {
      let reads = 0
      let probes = 0
      const client = {
        getMarketplaceCatalog: async () => {
          reads += 1
          return {
            artifacts: fixture.artifacts,
            catalogId,
            installations: [],
            releaseId: catalogId,
            state: 'ready',
          }
        },
      } as unknown as AgentHqApiClient
      const provider = createRegistryPluginsProvider({
        client,
        getWorkspaceId: () => 'workspace-1',
        getUserId: () => 'user-1',
      })
      await provider.list()
      expect(reads).toBe(1)

      // Nothing was published: the index still reports the identity in hand.
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === indexUrl) probes += 1
        return new Response(JSON.stringify({ catalogId }), {
          headers: { 'content-type': 'application/json' },
        })
      }) as unknown as typeof fetch
      setSystemTime(new Date(Date.now() + 16 * 60 * 1000))
      await provider.list()
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(probes).toBeGreaterThan(0)
      expect(reads).toBe(1)

      // Something was published: the full read happens again.
      globalThis.fetch = (async () => {
        probes += 1
        return new Response(JSON.stringify({ catalogId: `catalog:${'9'.repeat(64)}` }), {
          headers: { 'content-type': 'application/json' },
        })
      }) as unknown as typeof fetch
      setSystemTime(new Date(Date.now() + 32 * 60 * 1000))
      await provider.list()
      await new Promise((resolve) => setTimeout(resolve, 50))
      // One read for the changed catalog, and only one: a stale call renders
      // from the snapshot and lets its single scheduled refresh do the reading.
      expect(reads).toBe(2)
    } finally {
      globalThis.fetch = previousFetch
      storage.restore()
      setSystemTime(new Date())
    }
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

describe('compiled brand marks', () => {
  test('reads the marks the marketplace compiled', () => {
    const marks = compiledBrandMarks(
      JSON.stringify({
        brandMarks: {
          gmail: 'https://cdn.example/catalog/abc/icon-1.png',
          notion: 'http://insecure/icon.png',
        },
        catalogId: 'catalog:abc',
        schemaVersion: 1,
      })
    )
    expect(marks.get('gmail')).toBe('https://cdn.example/catalog/abc/icon-1.png')
    expect(marks.has('notion')).toBe(false)
    expect(marks.size).toBe(1)
  })

  test('ignores navigation without usable marks', () => {
    expect(compiledBrandMarks(undefined).size).toBe(0)
    expect(compiledBrandMarks('not json').size).toBe(0)
    expect(compiledBrandMarks(JSON.stringify({ brandMarks: 'nope' })).size).toBe(0)
    expect(compiledBrandMarks(JSON.stringify({ categories: [] })).size).toBe(0)
  })

  test('the compiled mark wins over the favicon heuristics', () => {
    const plugin = {
      icons: [],
      homepage: 'https://github.com/openai/plugins',
      upstreamPluginName: 'gmail',
    }
    expect(pluginIconUrl(plugin)).toBeDefined()
    expect(pluginIconUrl(plugin, 'https://cdn.example/catalog/abc/icon-1.png')).toBe(
      'https://cdn.example/catalog/abc/icon-1.png'
    )
    // A mark the plugin itself declares still outranks a compiled one.
    expect(
      pluginIconUrl({ ...plugin, icons: ['https://vendor.example/icon.svg'] }, 'https://cdn/x.png')
    ).toBe('https://vendor.example/icon.svg')
  })
})

describe('browsing from the published index', () => {
  const release = {
    canonicalContentDigest: `sha256:${'b'.repeat(64)}`,
    capabilities: [{ name: 'Read mail', type: 'connector' }],
    contentResolution: 'complete',
    packageStatus: 'portable',
    releaseId: `release:${'c'.repeat(64)}`,
    requiredConnectors: ['gmail'],
    requiredCredentials: ['google.oauth'],
    sourceRevision: 'a'.repeat(40),
  }
  const indexText = JSON.stringify({
    catalogId: 'catalog:abc',
    products: {
      gmail: {
        authors: ['OpenAI'],
        categories: ['productivity'],
        description: 'Search mail.',
        displayName: 'Gmail',
        keywords: ['mail'],
        license: 'Apache-2.0',
        pluginId: 'plugin:openai-official:gmail',
        provenance: {
          pluginSubdirectory: '.',
          repositoryUrl: 'https://github.com/openai/plugins',
          resolvedCommitSha: 'a'.repeat(40),
        },
        release,
        securityClassification: { level: 'standard' },
        sourceId: 'openai-official',
        upstreamName: 'gmail',
      },
    },
    schemaVersion: 1,
  })
  const navigation = JSON.stringify({
    catalogId: 'catalog:abc',
    catalogIndexUrl: 'https://cdn.example/catalog-index.json',
  })

  test('reads the index URL the navigation artifact publishes', () => {
    expect(navigationCatalogIndexUrl(navigation)).toBe('https://cdn.example/catalog-index.json')
    expect(navigationCatalogIndexUrl(undefined)).toBeUndefined()
    expect(navigationCatalogIndexUrl('not json')).toBeUndefined()
    expect(
      navigationCatalogIndexUrl(JSON.stringify({ catalogIndexUrl: 'http://insecure' }))
    ).toBeUndefined()
  })

  test('maps a browsing card and its install facts from the index', async () => {
    const digest = await canonicalDigest(indexText)
    const verified = {
      artifacts: {
        'categories.v1.json': navigation,
        'integrity.json': JSON.stringify({ files: { 'catalog-index.v1.json': digest } }),
      },
      catalog: { catalogId: 'catalog:abc' },
    } as unknown as VerifiedRegistryCatalog
    const fetched: string[] = []
    const catalog = await loadBrowsingCatalog(verified, (async (url: string) => {
      fetched.push(String(url))
      return new Response(indexText, { status: 200 })
    }) as unknown as typeof fetch)
    expect(fetched).toEqual(['https://cdn.example/catalog-index.json'])
    const [plugin] = mapRegistryCatalog(catalog!, [], new Map())
    // Identity the icon fallback depends on survives the reshape.
    expect(catalog!.plugins[0]!.upstreamPluginName).toBe('gmail')
    expect(plugin).toMatchObject({
      id: 'plugin:openai-official:gmail',
      kind: 'connector',
      name: 'Gmail',
      publisher: 'OpenAI',
      requiredConnectors: ['gmail'],
      requiredCredentials: ['google.oauth'],
      sourceRevision: 'a'.repeat(40),
      agentPluginsStatus: 'portable',
    })
  })

  test('refuses an index that does not match the declared digest', async () => {
    const digest = await canonicalDigest(indexText)
    const verified = {
      artifacts: {
        'categories.v1.json': navigation,
        'integrity.json': JSON.stringify({ files: { 'catalog-index.v1.json': digest } }),
      },
      catalog: { catalogId: 'catalog:abc' },
    } as unknown as VerifiedRegistryCatalog
    expect(
      await loadBrowsingCatalog(
        verified,
        (async () => new Response('{"different":true}', { status: 200 })) as unknown as typeof fetch
      )
    ).toBeUndefined()
  })
})

describe('plugin icon resolution', () => {
  test('prefers an upstream-provided icon URL', () => {
    expect(
      pluginIconUrl({
        icons: ['https://example.com/logo.svg'],
        homepage: 'https://gmail.com',
        upstreamPluginName: 'gmail',
      })
    ).toBe('https://example.com/logo.svg')
  })

  test('resolves company favicons and brand marks for repository homepages', () => {
    // Mapped org → the company site's favicon is the provider logo.
    expect(
      pluginIconUrl({
        icons: [],
        homepage:
          'https://github.com/adobe/skills/tree/main/plugins/creative-cloud/adobe-for-creativity',
        upstreamPluginName: 'adobe-for-creativity',
      })
    ).toBe('https://www.google.com/s2/favicons?domain=www.adobe.com&sz=64')
    expect(
      pluginIconUrl({
        icons: [],
        homepage: 'https://github.com/awslabs/agent-plugins',
        upstreamPluginName: 'deploy-on-aws',
      })
    ).toBe('https://www.google.com/s2/favicons?domain=aws.amazon.com&sz=64')
  })

  test('falls back to the org favicon for unmapped brands on mapped orgs', () => {
    expect(
      pluginIconUrl({
        icons: [],
        homepage: 'https://github.com/gemini-cli-extensions/spanner',
        upstreamPluginName: 'spanner',
      })
    ).toBe('https://www.google.com/s2/favicons?domain=cloud.google.com&sz=64')
  })

  test('falls back to the Simple Icons brand mark by upstream name', () => {
    expect(pluginIconUrl({ icons: [], upstreamPluginName: 'gmail' })).toBe(
      'https://cdn.simpleicons.org/gmail'
    )
    expect(pluginIconUrl({ icons: [], upstreamPluginName: 'has spaces' })).toBeUndefined()
  })

  test('returns undefined without any resolvable source', () => {
    expect(pluginIconUrl({ icons: [] })).toBeUndefined()
    expect(pluginBrandIconUrl('')).toBeUndefined()
    expect(pluginBrandIconUrl('../etc')).toBeUndefined()
  })
})

describe('plugin grouping and search cost', () => {
  const categories = [...workspacePluginCategoryOrder, 'Unknown Extra'] as never[]

  const plugin = (index: number) => ({
    capabilities: ['cap'],
    category: categories[index % categories.length]!,
    description: 'a reasonably long description of the plugin',
    id: `p${index}`,
    installed: index % 3 === 0,
    keywords: ['shared', `kw${index}`],
    kind: 'app' as const,
    name: `Plugin ${index}`,
    ownership: 'community' as const,
    publisher: 'Someone',
    surfaces: ['app'] as const,
    version: '1',
  })

  test('groups in the canonical order, including a category it does not know', () => {
    // The previous shape filtered the whole list once per category
    // (O(categories x plugins)). This pins the OUTPUT of the single-pass
    // version against that shape exactly, so the optimisation cannot quietly
    // reorder the App Library rail.
    const plugins = Array.from({ length: 53 }, (_, index) => plugin(index))
    const preferred = new Map<string, number>(
      workspacePluginCategoryOrder.map((category, order) => [category, order])
    )
    const names = [...new Set(plugins.map((entry) => entry.category))].toSorted(
      (left, right) =>
        (preferred.get(left) ?? Number.MAX_SAFE_INTEGER) -
          (preferred.get(right) ?? Number.MAX_SAFE_INTEGER) || left.localeCompare(right)
    )
    const previous = names.flatMap((category) => {
      const items = plugins.filter((entry) => entry.category === category)
      return items.length > 0 ? [{ category, plugins: items }] : []
    })

    const grouped = groupWorkspacePlugins(plugins)
    expect(grouped.map((group) => group.category)).toEqual(previous.map((group) => group.category))
    expect(grouped.map((group) => group.plugins.map((entry) => entry.id))).toEqual(
      previous.map((group) => group.plugins.map((entry) => entry.id))
    )
    // An unlisted category sorts last rather than being dropped.
    expect(grouped.at(-1)?.category).toBe('Unknown Extra')
  })

  test('a memoised haystack never serves stale text', () => {
    // The search text is built once per plugin OBJECT and reused, so the risk
    // this guards is a cache outliving the data. Two different needles over the
    // same plugin set must each match only their own results; a haystack cached
    // wrongly would return the wrong rows on the second query.
    const plugins = Array.from({ length: 40 }, (_, index) => plugin(index))
    expect(filterWorkspacePlugins(plugins, 'marketplace', 'Plugin 7').map((p) => p.id)).toContain(
      'p7'
    )
    // A needle matching nothing must match nothing, even after a populated
    // query has warmed the cache for every plugin.
    expect(filterWorkspacePlugins(plugins, 'marketplace', 'no-such-needle')).toEqual([])
    // And the original needle still works afterwards.
    expect(filterWorkspacePlugins(plugins, 'marketplace', 'Plugin 7').map((p) => p.id)).toContain(
      'p7'
    )
    // A non-name field that participates in the match is still searched.
    expect(filterWorkspacePlugins(plugins, 'marketplace', 'shared').length).toBe(40)
  })
})
