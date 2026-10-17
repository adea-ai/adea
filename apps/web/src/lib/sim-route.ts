import { parseSimCharacterValue, type SimNavigateTarget } from '@adea-ai/spatial/sim-bridge'

type RouteWindow = Pick<Window, 'location' | 'history' | 'dispatchEvent'>
export type SimSaveIdentity = Readonly<{
  signal: AbortSignal
  workspaceId: string
  surface: string
  bridgeId: string
  attempt: number
}>

/** The parent URL is the existing character selection store, including across reloads. */
export function commitSimCharacter(
  win: RouteWindow,
  character: string,
  request: SimSaveIdentity,
  current: { workspaceId: string; surface: string; bridgeId?: string }
): boolean {
  if (
    request.signal.aborted ||
    request.workspaceId !== current.workspaceId ||
    request.surface !== 'character-designer' ||
    request.surface !== current.surface ||
    request.bridgeId !== current.bridgeId ||
    !Number.isSafeInteger(request.attempt) ||
    request.attempt < 1 ||
    parseSimCharacterValue(character) === null
  )
    return false
  const url = new URL(win.location.href)
  url.searchParams.set('character', character)
  // No await separates the cancellation/identity check and the canonical write.
  // Notify the router too, so a later search patch cannot restore its old value.
  win.history.replaceState(win.history.state, '', url)
  win.dispatchEvent(new Event('popstate'))
  return new URL(win.location.href).searchParams.get('character') === character
}

export function navigateSimDesigner(win: RouteWindow, target: SimNavigateTarget): void {
  const url = new URL(win.location.href)
  url.searchParams.set('view', 'virtual')
  url.searchParams.delete('app')
  url.searchParams.delete('roomDesigner')
  url.searchParams.delete('characterDesigner')
  url.searchParams.set(target === 'room-designer' ? 'roomDesigner' : 'characterDesigner', '1')
  win.history.replaceState(win.history.state, '', url)
  win.dispatchEvent(new Event('popstate'))
}
