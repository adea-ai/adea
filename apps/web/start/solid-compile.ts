/**
 * Solid compiles hydratable output by default here, because Start server-renders
 * the sign-in and invite pages and hydrates them. The workspace route is
 * `ssr: false` and mounts inside `ClientOnly`, so the Dev View and the shared UI
 * components only it uses run in the browser alone: their client build is
 * compiled without the hydration helpers. The shared controls the server-rendered
 * pages use stay hydratable.
 *
 * The server environment compiles every module for SSR (the dev server loads the
 * whole route graph), but the production server bundle holds only what a server
 * rendered page imports, so the build fails if a client-only module is in it:
 * the client could not adopt that markup.
 */
import viteSolid from 'vite-plugin-solid'
import type { Plugin } from 'vite'

/** Shared UI the server-rendered pages import; these keep the hydratable compile. */
const SERVER_RENDERED_UI =
  /\/components\/(?:appearance-host|ui\/(?:alert|button|field|input|label|text-link|toggle|toggle-group|typography)\/)/

export function isClientOnlySolidSource(id: string): boolean {
  const path = id.replaceAll('\\', '/').replace(/\?.*$/, '')
  if (!path.endsWith('.tsx')) return false
  if (/\/packages\/dev-view\/src\//.test(path)) return true
  return (
    /\/node_modules\/@adea-ai\/ui\/src\/components\//.test(path) && !SERVER_RENDERED_UI.test(path)
  )
}

type Compile = 'hydratable' | 'client-only'

function limitTo(compile: Compile, plugin: Plugin): Plugin {
  const transform = plugin.transform
  if (typeof transform !== 'function') return plugin
  return {
    ...plugin,
    transform(this: ThisParameterType<typeof transform>, source, id, options) {
      const clientOnlySource = isClientOnlySolidSource(id)
      const client = this.environment.config.consumer === 'client'
      const applies =
        compile === 'hydratable' ? !(clientOnlySource && client) : clientOnlySource && client
      return applies ? transform.call(this, source, id, options) : null
    },
  }
}

/**
 * The browser-only pass needs just the compile step (and the dev refresh switch
 * `configResolved` sets); the first instance already carries the configuration.
 */
export function solidPlugins(): Plugin[] {
  const [clientOnly] = [viteSolid({ solid: { hydratable: false } })].flat()
  return [
    ...[viteSolid({ ssr: true })].flat().map((plugin) => limitTo('hydratable', plugin)),
    limitTo('client-only', {
      name: 'solid-client-only',
      enforce: clientOnly!.enforce,
      configResolved: clientOnly!.configResolved,
      transform: clientOnly!.transform,
    } as Plugin),
    {
      name: 'adea-solid-client-only-boundary',
      apply: 'build',
      generateBundle(_options, bundle) {
        if (this.environment.config.consumer === 'client') return
        for (const output of Object.values(bundle)) {
          if (output.type !== 'chunk') continue
          for (const id of Object.keys(output.modules)) {
            if (isClientOnlySolidSource(id))
              this.error(`Client-only Solid module in the server build: ${id}`)
          }
        }
      },
    },
  ]
}
