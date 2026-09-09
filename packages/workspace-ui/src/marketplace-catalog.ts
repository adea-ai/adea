import type {
  AgentHqApiClient,
  ApiMarketplaceCatalogResponse,
  ApiMarketplaceInstallResponse,
} from '@adea-ai/api-client'

import type {
  WorkspacePlugin,
  WorkspacePluginInstallationStatus,
  WorkspacePluginsProviderState,
} from './platform'

type JsonObject = Record<string, unknown>

export type RegistryArtifactBundle = Readonly<{
  'catalog.v1.json': string
  'catalog-latest.v1.json': string
  'catalog-summary.v1.json': string
  'categories.v1.json': string
  'compatibility.v1.json': string
  'integrity.json': string
  'sources.lock.json': string
}>

export type RegistryCatalog = Readonly<{
  schemaVersion: 1
  catalogId: string
  generatedAt: string
  sources: readonly JsonObject[]
  plugins: readonly RegistryPlugin[]
}>

export type RegistryPlugin = Readonly<{
  pluginId: string
  displayName: string
  description: string
  productGroupingKey: string
  categories: readonly string[]
  keywords: readonly string[]
  authors: readonly string[]
  homepage?: string
  icons: readonly string[]
  sourceId: string
  currentReleaseId: string
  availableReleases: readonly RegistryRelease[]
  capabilitySummary: JsonObject
  harnessCompatibility: JsonObject
  license: JsonObject
  provenance: JsonObject
  securityClassification: JsonObject
  [key: string]: unknown
}>

export type RegistryRelease = Readonly<{
  releaseId: string
  canonicalContentDigest: string
  contentResolution: 'complete' | 'metadata-only'
  requiredConnectors: readonly string[]
  requiredCredentials: readonly string[]
  capabilities: readonly Readonly<{
    type: string
    name: string
    paths: readonly string[]
    metadata: JsonObject
    securityImpact: string
  }>[]
  releaseMetadata: JsonObject
  /** Canonical Agent Plugins descriptor, when this release was resynchronized. */
  agentPlugins?: JsonObject
  packageDigest?: string
  [key: string]: unknown
}>

export type VerifiedRegistryCatalog = Readonly<{
  catalog: RegistryCatalog
  artifacts: RegistryArtifactBundle
  releaseId: string
  state: 'ready' | 'stale'
  installations: readonly {
    pluginId: string
    releaseId: string
    canonicalContentDigest: string
    installationInstanceId?: string
    packageDigest?: string
    state: WorkspacePluginInstallationStatus
  }[]
}>

export class MarketplaceCatalogError extends Error {
  constructor(
    readonly state: Exclude<WorkspacePluginsProviderState, 'idle' | 'loading' | 'ready'>,
    message: string
  ) {
    super(message)
    this.name = 'MarketplaceCatalogError'
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const object = value as JsonObject
  return `{${Object.keys(object)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`
}

export async function canonicalDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

export function parseJsonArtifact(text: string, name: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new MarketplaceCatalogError(
      'verification-failure',
      `Marketplace artifact is not JSON: ${name}`
    )
  }
}

export async function verifyRegistryArtifacts(
  artifacts: RegistryArtifactBundle
): Promise<VerifiedRegistryCatalog> {
  const rawCatalog = parseJsonArtifact(artifacts['catalog.v1.json'], 'catalog.v1.json')
  const catalog = parseCatalog(rawCatalog)
  const summary = requireObject(
    parseJsonArtifact(artifacts['catalog-summary.v1.json'], 'catalog-summary.v1.json'),
    'catalog-summary.v1.json'
  )
  const categories = requireObject(
    parseJsonArtifact(artifacts['categories.v1.json'], 'categories.v1.json'),
    'categories.v1.json'
  )
  const compatibility = requireObject(
    parseJsonArtifact(artifacts['compatibility.v1.json'], 'compatibility.v1.json'),
    'compatibility.v1.json'
  )
  const lock = requireObject(
    parseJsonArtifact(artifacts['sources.lock.json'], 'sources.lock.json'),
    'sources.lock.json'
  )
  const integrity = requireObject(
    parseJsonArtifact(artifacts['integrity.json'], 'integrity.json'),
    'integrity.json'
  )
  const expectedFiles = [
    'catalog.v1.json',
    'catalog-summary.v1.json',
    'categories.v1.json',
    'compatibility.v1.json',
    'sources.lock.json',
  ] as const
  const integrityFiles = isStringRecord(integrity.files) ? integrity.files : undefined
  if (
    integrity.schemaVersion !== 1 ||
    integrity.catalogId !== catalog.catalogId ||
    integrityFiles === undefined ||
    Object.keys(integrityFiles).length !== expectedFiles.length ||
    expectedFiles.some((name) => integrityFiles[name] === undefined)
  ) {
    throw new MarketplaceCatalogError(
      'verification-failure',
      'Marketplace integrity metadata is invalid'
    )
  }
  if (
    summary.schemaVersion !== 1 ||
    summary.catalogId !== catalog.catalogId ||
    summary.pluginCount !== catalog.plugins.length ||
    categories.schemaVersion !== 1 ||
    categories.catalogId !== catalog.catalogId ||
    !Array.isArray(categories.categories) ||
    compatibility.schemaVersion !== 1 ||
    compatibility.catalogId !== catalog.catalogId ||
    !Array.isArray(compatibility.plugins) ||
    lock.schemaVersion !== 1
  ) {
    throw new MarketplaceCatalogError(
      'verification-failure',
      'Marketplace artifact metadata does not match the catalog'
    )
  }
  for (const name of expectedFiles) {
    const expected = integrityFiles[name]!
    if ((await canonicalDigest(artifacts[name])) !== expected) {
      throw new MarketplaceCatalogError(
        'verification-failure',
        `Marketplace artifact digest mismatch: ${name}`
      )
    }
  }
  if (artifacts['catalog-latest.v1.json'] !== artifacts['catalog.v1.json']) {
    throw new MarketplaceCatalogError(
      'verification-failure',
      'Marketplace latest pointer is not byte-identical'
    )
  }
  const { catalogId: _catalogId, ...catalogBody } = requireObject(rawCatalog, 'catalog.v1.json')
  const expectedCatalogId = `catalog:${(await canonicalDigest(catalogBody)).slice('sha256:'.length)}`
  if (expectedCatalogId !== catalog.catalogId) {
    throw new MarketplaceCatalogError(
      'verification-failure',
      'Marketplace catalogId does not match its canonical body'
    )
  }
  // The registry does not add a second mutable release identifier to the catalog
  // body. The catalogId is the immutable release identity for this artifact set.
  return { catalog, artifacts, releaseId: catalog.catalogId, state: 'ready', installations: [] }
}

export function parseCatalog(value: unknown): RegistryCatalog {
  const candidate = requireObject(value, 'catalog.v1.json') as JsonObject & {
    catalogId: string
    generatedAt: string
    plugins: readonly unknown[]
    schemaVersion: unknown
    sources: readonly unknown[]
  }
  if (
    candidate.schemaVersion !== 1 ||
    !/^catalog:[a-f0-9]{64}$/.test(stringValue(candidate.catalogId)) ||
    !timestamp(candidate.generatedAt) ||
    !Array.isArray(candidate.sources) ||
    !Array.isArray(candidate.plugins)
  ) {
    throw new MarketplaceCatalogError(
      'verification-failure',
      'Marketplace catalog schema is invalid'
    )
  }
  const plugins = candidate.plugins.map((plugin, index) => parsePlugin(plugin, index))
  const ids = new Set<string>()
  for (const plugin of plugins) {
    if (ids.has(plugin.pluginId)) {
      throw new MarketplaceCatalogError(
        'verification-failure',
        `Duplicate marketplace pluginId: ${plugin.pluginId}`
      )
    }
    ids.add(plugin.pluginId)
  }
  return {
    schemaVersion: 1,
    catalogId: candidate.catalogId,
    generatedAt: candidate.generatedAt,
    sources: candidate.sources.map((source) => requireObject(source, 'catalog source')),
    plugins,
  }
}

export function mapRegistryCatalog(
  catalog: RegistryCatalog,
  installations: readonly VerifiedRegistryCatalog['installations'][number][]
): readonly WorkspacePlugin[] {
  const states = new Map(installations.map((installation) => [installation.pluginId, installation]))
  return catalog.plugins.map((plugin) => {
    const release = plugin.availableReleases.find(
      (candidate) => candidate.releaseId === plugin.currentReleaseId
    )
    if (!release)
      throw new MarketplaceCatalogError(
        'verification-failure',
        `Current release is missing: ${plugin.pluginId}`
      )
    const installation = states.get(plugin.pluginId)
    const agentPlugins =
      release.agentPlugins ??
      (isObject(release.releaseMetadata['agentPlugins'])
        ? release.releaseMetadata['agentPlugins']
        : undefined)
    const agentPluginsStatus = agentPlugins ? agentPluginsStatusValue(agentPlugins['status']) : ''
    const packageDigest = agentPlugins ? digestValue(agentPlugins['packageDigest']) : undefined
    const installable =
      release.contentResolution !== 'metadata-only' && agentPluginsStatus !== 'unavailable'
    const releasePackageDigest = release.packageDigest ?? packageDigest
    const installationStatus =
      installation &&
      installation.releaseId === release.releaseId &&
      installation.canonicalContentDigest === release.canonicalContentDigest &&
      (releasePackageDigest === undefined || installation.packageDigest === releasePackageDigest)
        ? installation.state
        : installable
          ? 'available'
          : 'unavailable'
    const capabilities = release.capabilities.map((capability) => capability.name)
    const capabilityTypes = new Set(release.capabilities.map((capability) => capability.type))
    const connector =
      capabilityTypes.has('connector') ||
      capabilityTypes.has('mcp-server') ||
      release.requiredConnectors.length > 0
    const surfaces = [
      ...new Set(release.capabilities.map((capability) => surfaceForCapability(capability.type))),
    ]
    return {
      auth:
        release.requiredCredentials.length > 0
          ? release.requiredConnectors.length > 0
            ? 'oauth'
            : 'api-key'
          : 'workspace',
      authenticationPolicy: release.requiredCredentials.length > 0 ? 'on-install' : 'on-use',
      capabilities: capabilities.length > 0 ? capabilities : ['Plugin metadata'],
      categories: plugin.categories,
      category: categoryLabel(plugin.categories[0] ?? 'other'),
      contentResolution: release.contentResolution,
      description: plugin.description,
      harnessCompatibility: plugin.harnessCompatibility,
      homepage: plugin.homepage,
      iconKey: `registry:${plugin.pluginId}`,
      iconUrl: plugin.icons[0],
      icons: plugin.icons,
      id: plugin.pluginId,
      installed: installationStatus === 'installed',
      installationPolicy: installationStatus === 'unavailable' ? 'not-available' : 'available',
      ...(agentPluginsStatus ? { agentPluginsStatus } : {}),
      installationStatus,
      kind: connector ? 'connector' : 'skill',
      keywords: plugin.keywords,
      license: stringValue(plugin.license.name),
      licenseMetadata: plugin.license,
      name: plugin.displayName,
      authors: plugin.authors,
      ownership: 'public',
      pluginId: plugin.pluginId,
      productGroupingKey: plugin.productGroupingKey,
      provenance: plugin.provenance,
      publisher: plugin.authors[0] ?? plugin.sourceId,
      releaseId: release.releaseId,
      canonicalContentDigest: release.canonicalContentDigest,
      ...((release.packageDigest ?? packageDigest)
        ? { packageDigest: release.packageDigest ?? packageDigest }
        : {}),
      requiredConnectors: release.requiredConnectors,
      requiredCredentials: release.requiredCredentials,
      securityClassification: plugin.securityClassification,
      source: plugin.sourceId,
      sourceId: plugin.sourceId,
      sourceRevision: stringValue(plugin.provenance.resolvedCommitSha),
      sourceUrl: stringValue(plugin.provenance.repositoryUrl),
      surfaces,
      updateMetadata: release.releaseMetadata,
    } satisfies WorkspacePlugin
  })
}

export function categoryLabel(value: string): string {
  return value
    .split('-')
    .filter(Boolean)
    .map((part) => `${part[0]?.toLocaleUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ')
}

export async function loadRegistryArtifacts(
  client: AgentHqApiClient,
  workspaceId: string
): Promise<VerifiedRegistryCatalog> {
  const response = await client.getMarketplaceCatalog(workspaceId)
  const artifacts = response.artifacts
  const verified = await verifyRegistryArtifacts(artifacts)
  if (
    response.catalogId !== verified.catalog.catalogId ||
    response.releaseId !== verified.releaseId
  ) {
    throw new MarketplaceCatalogError(
      'verification-failure',
      'Control Plane returned an inconsistent marketplace snapshot identity'
    )
  }
  return {
    ...verified,
    state: response.state,
    installations: response.installations ?? [],
  }
}

export function installationResponseState(
  response: ApiMarketplaceInstallResponse
): WorkspacePluginInstallationStatus {
  return response.state
}

export function registryResponseArtifacts(
  response: ApiMarketplaceCatalogResponse
): RegistryArtifactBundle {
  return response.artifacts
}

function parsePlugin(value: unknown, index: number): RegistryPlugin {
  const plugin = requireObject(value, `catalog.plugins[${index}]`) as JsonObject & {
    authors?: unknown
    availableReleases: readonly unknown[]
    capabilitySummary?: unknown
    categories: readonly unknown[]
    currentReleaseId: string
    description?: unknown
    displayName: string
    harnessCompatibility: JsonObject
    homepage?: unknown
    icons: readonly unknown[]
    keywords?: unknown
    license: JsonObject
    pluginId: string
    productGroupingKey?: unknown
    provenance: JsonObject
    securityClassification: JsonObject
    sourceId: string
  }
  if (
    !/^plugin:[a-z0-9-]+:[a-z0-9][a-z0-9-]{1,127}$/.test(stringValue(plugin.pluginId)) ||
    !stringValue(plugin.displayName) ||
    !Array.isArray(plugin.categories) ||
    !Array.isArray(plugin.icons) ||
    !stringValue(plugin.sourceId) ||
    !/^release:[a-f0-9]{64}$/.test(stringValue(plugin.currentReleaseId)) ||
    !Array.isArray(plugin.availableReleases) ||
    !isObject(plugin.harnessCompatibility) ||
    !isObject(plugin.license) ||
    !isObject(plugin.provenance) ||
    !isObject(plugin.securityClassification)
  ) {
    throw new MarketplaceCatalogError(
      'verification-failure',
      `Marketplace plugin schema is invalid: ${plugin.pluginId || index}`
    )
  }
  if (
    !plugin.categories.every(isString) ||
    !plugin.icons.every(isString) ||
    (plugin.authors !== undefined &&
      (!Array.isArray(plugin.authors) || !plugin.authors.every(isString))) ||
    (plugin.keywords !== undefined &&
      (!Array.isArray(plugin.keywords) || !plugin.keywords.every(isString)))
  ) {
    throw new MarketplaceCatalogError(
      'verification-failure',
      `Marketplace plugin metadata is malformed: ${plugin.pluginId || index}`
    )
  }
  const releases = plugin.availableReleases.map((release, releaseIndex) =>
    parseRelease(release, `${index}.${releaseIndex}`)
  )
  if (!releases.some((release) => release.releaseId === plugin.currentReleaseId)) {
    throw new MarketplaceCatalogError(
      'verification-failure',
      `Current release is invalid: ${plugin.pluginId}`
    )
  }
  return {
    ...plugin,
    pluginId: plugin.pluginId,
    displayName: plugin.displayName,
    description: stringValue(plugin.description),
    productGroupingKey: stringValue(plugin.productGroupingKey),
    categories: plugin.categories,
    keywords: Array.isArray(plugin.keywords) ? plugin.keywords : [],
    authors: Array.isArray(plugin.authors) ? plugin.authors : [],
    homepage: stringValue(plugin.homepage) || undefined,
    icons: plugin.icons.filter(isString),
    sourceId: plugin.sourceId,
    currentReleaseId: plugin.currentReleaseId,
    availableReleases: releases,
    capabilitySummary: requireObject(plugin.capabilitySummary ?? {}, 'capabilitySummary'),
    harnessCompatibility: plugin.harnessCompatibility,
    license: plugin.license,
    provenance: plugin.provenance,
    securityClassification: plugin.securityClassification,
  }
}

function parseRelease(value: unknown, index: string): RegistryRelease {
  const release = requireObject(value, `catalog.release[${index}]`) as JsonObject & {
    canonicalContentDigest: string
    capabilities: readonly unknown[]
    contentResolution: string
    releaseId: string
    releaseMetadata: JsonObject
    requiredConnectors: readonly unknown[]
    requiredCredentials: readonly unknown[]
  }
  if (
    !/^release:[a-f0-9]{64}$/.test(stringValue(release.releaseId)) ||
    !/^sha256:[a-f0-9]{64}$/.test(stringValue(release.canonicalContentDigest)) ||
    !['complete', 'metadata-only'].includes(stringValue(release.contentResolution)) ||
    !Array.isArray(release.requiredConnectors) ||
    !Array.isArray(release.requiredCredentials) ||
    !Array.isArray(release.capabilities) ||
    !isObject(release.releaseMetadata)
  )
    throw new MarketplaceCatalogError(
      'verification-failure',
      `Marketplace release schema is invalid: ${index}`
    )
  if (
    !release.requiredConnectors.every(isString) ||
    !release.requiredCredentials.every(isString) ||
    !release.capabilities.every(isObject)
  )
    throw new MarketplaceCatalogError(
      'verification-failure',
      `Marketplace release metadata is malformed: ${index}`
    )
  return {
    ...release,
    releaseId: release.releaseId,
    canonicalContentDigest: release.canonicalContentDigest,
    contentResolution: release.contentResolution as RegistryRelease['contentResolution'],
    requiredConnectors: release.requiredConnectors,
    requiredCredentials: release.requiredCredentials,
    capabilities: release.capabilities.map(
      (capability) =>
        requireObject(capability, 'capability') as RegistryRelease['capabilities'][number]
    ),
    releaseMetadata: release.releaseMetadata,
    ...(isObject(release.releaseMetadata['agentPlugins'])
      ? {
          agentPlugins: release.releaseMetadata['agentPlugins'],
          ...(digestValue(release.releaseMetadata['agentPlugins']['packageDigest'])
            ? {
                packageDigest: digestValue(
                  release.releaseMetadata['agentPlugins']['packageDigest']
                ),
              }
            : {}),
        }
      : {}),
  }
}

function surfaceForCapability(
  type: string
): 'agent' | 'app' | 'command' | 'hook' | 'mcp' | 'skill' {
  if (type === 'mcp-server' || type === 'connector') return 'mcp'
  if (type === 'command') return 'command'
  if (type === 'agent') return 'agent'
  if (type === 'hook') return 'hook'
  return 'skill'
}

function requireObject(value: unknown, name: string): JsonObject {
  if (!isObject(value))
    throw new MarketplaceCatalogError('verification-failure', `${name} must be an object`)
  return value
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every(isString)
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function digestValue(value: unknown): string | undefined {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value) ? value : undefined
}

function agentPluginsStatusValue(value: unknown): 'portable' | 'partial' | 'unavailable' | '' {
  return value === 'portable' || value === 'partial' || value === 'unavailable' ? value : ''
}

function timestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}
