export const PRIVATE_HEADERS: Readonly<Record<string, string>>
export const ENTRY_ACCESS_HEADER: string
export const ENTRY_ACCESS_VALUES: readonly string[]
export function failure(status: number, message: string, allow?: string): Response
export function rootDocumentPolicy(request: Request): Response | null
export function stripEntryAccessHeader(request: Request): Request
export function withEntryAccess(request: Request, access: 'allowed' | 'denied'): Request
export function finalizeDynamicResponse(response: Response, request: Request): Promise<Response>
