export const DEFAULT_CLOUD_ORIGIN: string
export const LOCAL_DEV_CLOUD_ORIGIN: string
export const DESKTOP_TARGET_FILE: string
export type DesktopTargetMode = 'release' | 'local' | 'hosted-dev'
export type DesktopTarget = { mode: DesktopTargetMode; cloudOrigin: string }
export function normalizeDesktopCloudOrigin(value?: string): string
export function isLoopbackCloudOrigin(origin: string): boolean
export function resolveCloudOrigin(options: {
  explicit?: string
  release: boolean
  allowHosted?: string
}): string
export function desktopBuildTarget(options: {
  explicit?: string
  release: boolean
  allowHosted?: string
}): DesktopTarget
export function serializeDesktopTarget(target: DesktopTarget): string
export function parseDesktopTarget(text: string): DesktopTarget
export function resolveShellCloudOrigin(
  target: DesktopTarget,
  options?: { explicit?: string; allowHosted?: string }
): string
