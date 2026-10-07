/** Resolve an explicit immutable pin; the Control Plane owns policy and Skill resolution. */
import type { ProfileResolutionResponse, WorkspaceAgentProfileGetResponse } from '@adea-ai/sdk'
import {
  ControlPlaneProxyError,
  postControlPlane,
  readEnvelope,
  scopedAdminCredential,
  type AdminCorrelation,
  type ControlPlaneHopDependencies,
} from './control-plane-client'

export async function resolveAgentProfilePin(
  input: Readonly<{ profileId: string; profileVersion: string }>,
  correlation: AdminCorrelation,
  dependencies: ControlPlaneHopDependencies
) {
  const now = dependencies.now?.() ?? Date.now()
  const parameters = { profileId: input.profileId, profileVersionId: input.profileVersion }
  const credential = await scopedAdminCredential(['catalog:read'], dependencies)
  const catalog = (await postControlPlane(
    credential,
    '/v1/catalog/profiles/get',
    readEnvelope(credential, correlation, 'catalog.profile.get', parameters, now),
    dependencies,
    'catalog.profile.get'
  )) as WorkspaceAgentProfileGetResponse['data']
  const version = catalog.version
  if (
    catalog.profile.profileId !== input.profileId ||
    (catalog.profile.ownership.scope === 'workspace' &&
      catalog.profile.ownership.workspaceId !== credential.workspaceId) ||
    !version ||
    version.profileId !== input.profileId ||
    version.profileVersionId !== input.profileVersion
  )
    throw new ControlPlaneProxyError(
      'AGENT_PROFILE_MISSING',
      'Select an available profile version',
      409
    )
  if (version.lifecycle !== 'published')
    throw new ControlPlaneProxyError(
      `AGENT_PROFILE_${version.lifecycle.toUpperCase()}`,
      'Select a published, approved profile version',
      409
    )
  const resolutionCredential = await scopedAdminCredential(['profile:resolve'], dependencies)
  const resolved = (await postControlPlane(
    resolutionCredential,
    '/v1/profiles/resolve',
    readEnvelope(resolutionCredential, correlation, 'profile.resolve', parameters, now),
    dependencies,
    'profile.resolve'
  )) as ProfileResolutionResponse['data']
  if (
    resolved.profile.profileId !== input.profileId ||
    resolved.profile.profileVersionId !== input.profileVersion ||
    resolved.profile.contentDigest !== version.contentDigest ||
    resolved.profile.revision !== version.revision ||
    resolved.profile.version !== version.version ||
    resolved.profile.schemaVersion !== version.schemaVersion
  )
    throw new ControlPlaneProxyError(
      'AGENT_PROFILE_CHANGED',
      'Refresh the profile catalog and retry',
      409
    )
  // Never return or persist the profile definition or compose its Skills in Adea.
  return {
    profileId: input.profileId,
    profileVersion: input.profileVersion,
    contentDigest: resolved.profile.contentDigest,
    catalogRevision: resolved.profile.revision,
    schemaVersion: resolved.profile.schemaVersion,
    skillVersionIds: resolved.skillVersionIds,
  }
}
