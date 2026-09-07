import { desktopCorsPreflight, desktopExchangeResponse } from '../../../../../server/desktop-auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export function OPTIONS(request: Request) {
  return desktopCorsPreflight(request)
}

export async function POST(request: Request) {
  return desktopExchangeResponse(request)
}
