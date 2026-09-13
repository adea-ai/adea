// Shell-agnostic desktop bridge for the single web UI. The shell injects
// `window.__adeaDesktop` before the client boots (see
// apps/desktop/shell/src/bun/index.ts); its presence is what makes this the
// desktop runtime. The command names and payloads are the desktop contract
// documented in docs/specs/desktop-auth.md and docs/specs/local-content.md.

export type DesktopShell = {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>
  listen(event: string, handler: (payload: unknown) => void): Promise<() => void>
}

declare global {
  interface Window {
    __adeaDesktop?: DesktopShell
  }
}

function shell(): DesktopShell {
  const bridge = typeof window !== 'undefined' ? window.__adeaDesktop : undefined
  if (!bridge) throw new Error('Adea desktop shell bridge is unavailable')
  return bridge
}

export function isDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && '__adeaDesktop' in window
}

export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return shell().invoke(cmd, args) as Promise<T>
}

export function listen<T>(
  event: string,
  handler: (payload: { payload: T }) => void
): Promise<() => void> {
  return shell().listen(event, handler as (payload: unknown) => void)
}

export async function getVersion(): Promise<string> {
  const version = await invoke<string>('adea_app_version')
  return version
}

/** Streaming channel stub for transcription parity with the previous shell. */
export class Channel<T> {
  onmessage: ((message: T) => void) | null = null
  constructor(onmessage?: (message: T) => void) {
    this.onmessage = onmessage ?? null
  }
  send(): void {
    throw new Error('channels are not supported by this shell yet')
  }
}
