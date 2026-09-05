export type SceneLoadScope = {
  signal: AbortSignal
  abort: () => void
  isAborted: () => boolean
}

/** Share one cancellation signal across fetch and Three.js scene loads. */
export function createSceneLoadScope(): SceneLoadScope {
  const controller = new AbortController()

  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    isAborted: () => controller.signal.aborted,
  }
}
