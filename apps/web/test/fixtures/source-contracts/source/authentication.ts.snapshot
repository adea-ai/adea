import { z } from 'zod'
import { IdentifierSchemas } from './identifiers.js'

const TimestampSchema = z.iso.datetime()
const ServicePrincipalIdSchema = z
  .string()
  .min(5)
  .max(64)
  .regex(/^svc_[a-z][a-z0-9-]*$/)
export const ServiceScopeSchema = z
  .string()
  .min(3)
  .max(96)
  .regex(/^[a-z][a-z0-9.-]*:[a-z][a-z0-9.-]*$/)
const uniqueValues = <Value>(values: Value[]) => new Set(values).size === values.length

export const ServiceCredentialKindSchema = z.enum([
  'service',
  'browser_session',
  'runtime_device',
  'provider',
])

export type ServiceCredentialKind = z.infer<typeof ServiceCredentialKindSchema>

export const ServiceCallerAssertionSchema = z.object({
  servicePrincipalId: ServicePrincipalIdSchema,
})

export type ServiceCallerAssertion = z.infer<typeof ServiceCallerAssertionSchema>

export const ServiceCredentialClaimsSchema = z
  .object({
    audience: z.string().min(1).max(256),
    credentialId: z.string().min(1).max(128),
    credentialKind: ServiceCredentialKindSchema,
    expiresAt: TimestampSchema,
    issuedAt: TimestampSchema,
    issuer: z.url().max(512),
    keyId: z.string().min(1).max(128),
    principalId: ServicePrincipalIdSchema,
    projectIds: z.array(IdentifierSchemas.projectId).max(256),
    scopes: z.array(ServiceScopeSchema).min(1).max(64).refine(uniqueValues),
    workspaceIds: z.array(IdentifierSchemas.workspaceId).min(1).max(256).refine(uniqueValues),
  })
  .refine((claims) => Date.parse(claims.expiresAt) > Date.parse(claims.issuedAt), {
    message: 'Credential expiry must be after issuance',
    path: ['expiresAt'],
  })

export type ServiceCredentialClaims = z.output<typeof ServiceCredentialClaimsSchema>

export const ServicePrincipalSchema = z.object({
  kind: z.enum(['agent_hq_service', 'internal_service']),
  principalId: ServicePrincipalIdSchema,
  projectIds: z.array(IdentifierSchemas.projectId).max(256).refine(uniqueValues),
  scopes: z.array(ServiceScopeSchema).min(1).max(64).refine(uniqueValues),
  workspaceIds: z.array(IdentifierSchemas.workspaceId).max(256).refine(uniqueValues),
})

export type ServicePrincipal = z.output<typeof ServicePrincipalSchema>
