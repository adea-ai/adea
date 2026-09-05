import { handleNeonAuthRequest } from '@agent-hq/auth/server'

type RouteContext = { params: Promise<{ path: string[] }> }

export const dynamic = 'force-dynamic'

export function GET(request: Request, context: RouteContext) {
  return handleNeonAuthRequest('GET', request, context)
}

export function POST(request: Request, context: RouteContext) {
  return handleNeonAuthRequest('POST', request, context)
}

export function PUT(request: Request, context: RouteContext) {
  return handleNeonAuthRequest('PUT', request, context)
}

export function PATCH(request: Request, context: RouteContext) {
  return handleNeonAuthRequest('PATCH', request, context)
}

export function DELETE(request: Request, context: RouteContext) {
  return handleNeonAuthRequest('DELETE', request, context)
}
