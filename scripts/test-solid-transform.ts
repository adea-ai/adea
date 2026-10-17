import { plugin } from 'bun'
import { readFileSync } from 'node:fs'

import { transformAsync } from '@babel/core'
import presetTypescript from '@babel/preset-typescript'
import presetSolid from 'babel-preset-solid'

// Bun's native test runner does not load vite-plugin-solid, so a test that imports
// a `.tsx` module gets the same DOM transform the build uses: babel-preset-solid
// compiles JSX to solid-js/web calls and preset-typescript strips types, leaving
// plain JavaScript for Bun's module loader. Without it Bun compiles the JSX as
// automatic dev JSX (`solid-js/jsx-dev-runtime`, which exports no `jsxDEV`) and
// the module fails to link.
plugin({
  name: 'solid-jsx',
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
      const source = readFileSync(path, 'utf8')
      // Babel installs an `Error.prepareStackTrace` rewriter on its first call and
      // raises `Error.stackTraceLimit`. With a custom `prepareStackTrace` set, Bun's
      // `Error.captureStackTrace` throws for any object that is not an Error, which
      // breaks `vite` (follow-redirects builds error types that way) in every later
      // test file of the same process. Restore both once Babel is done.
      const { prepareStackTrace, stackTraceLimit } = Error
      try {
        const result = await transformAsync(source, {
          filename: path,
          babelrc: false,
          configFile: false,
          sourceMaps: 'inline',
          presets: [
            // preset-typescript 8 dropped .isTSX/.allExtensions: JSX detection
            // is filename-based, and the onLoad filter only sees .tsx paths.
            presetTypescript,
            [presetSolid, { generate: 'dom', hydratable: false }],
          ],
        })
        return { contents: result?.code ?? source, loader: 'js' }
      } finally {
        Error.prepareStackTrace = prepareStackTrace
        Error.stackTraceLimit = stackTraceLimit
      }
    })
  },
})
