/** Published, version-pinned Control Plane operations used by Adea's host. */
import { ControlApiOperations, ControlPlaneClient } from '@adea-ai/sdk'

/** Keep the SDK's typed request parsing at each operation boundary. */
export function callControlPlaneOperation(
  client: ControlPlaneClient,
  path: string,
  body: Record<string, unknown>
): Promise<{ data: unknown; requestId: string; correlation: { traceId: string } }> {
  switch (path) {
    case ControlApiOperations.listRuntimeConnections.path:
      return client.listRuntimeConnections(
        ControlApiOperations.listRuntimeConnections.requestSchema.parse(body)
      )
    case ControlApiOperations.listWorkspaceSkills.path:
      return client.listWorkspaceSkills(
        ControlApiOperations.listWorkspaceSkills.requestSchema.parse(body)
      )
    case ControlApiOperations.listWorkspaceProfiles.path:
      return client.listWorkspaceProfiles(
        ControlApiOperations.listWorkspaceProfiles.requestSchema.parse(body)
      )
    case ControlApiOperations.publishWorkspaceSkill.path:
      return client.publishWorkspaceSkill(
        ControlApiOperations.publishWorkspaceSkill.requestSchema.parse(body)
      )
    case ControlApiOperations.deprecateWorkspaceSkill.path:
      return client.deprecateWorkspaceSkill(
        ControlApiOperations.deprecateWorkspaceSkill.requestSchema.parse(body)
      )
    case ControlApiOperations.revokeWorkspaceSkill.path:
      return client.revokeWorkspaceSkill(
        ControlApiOperations.revokeWorkspaceSkill.requestSchema.parse(body)
      )
    case ControlApiOperations.deprecateWorkspaceProfile.path:
      return client.deprecateWorkspaceProfile(
        ControlApiOperations.deprecateWorkspaceProfile.requestSchema.parse(body)
      )
    case ControlApiOperations.revokeWorkspaceProfile.path:
      return client.revokeWorkspaceProfile(
        ControlApiOperations.revokeWorkspaceProfile.requestSchema.parse(body)
      )
    case ControlApiOperations.createCredential.path:
      return client.createCredential(
        ControlApiOperations.createCredential.requestSchema.parse(body)
      )
    case ControlApiOperations.rotateCredential.path:
      return client.rotateCredential(
        ControlApiOperations.rotateCredential.requestSchema.parse(body)
      )
    case ControlApiOperations.revokeCredential.path:
      return client.revokeCredential(
        ControlApiOperations.revokeCredential.requestSchema.parse(body)
      )
    case ControlApiOperations.listCredentials.path:
      return client.listCredentials(ControlApiOperations.listCredentials.requestSchema.parse(body))
    default:
      throw new Error('Unsupported Control Plane operation')
  }
}
