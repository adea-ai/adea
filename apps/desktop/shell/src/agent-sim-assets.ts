// Compatibility refusal for the retired local engine mount. Never inspect
// a pack path or serve private bytes from the desktop process.
export const AGENT_SIM_MOUNT = '/assets/agent-sim/'

export async function agentSimResponse(
  _urlPath: string,
  _legacyPackRoot?: string
): Promise<Response> {
  return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } })
}
