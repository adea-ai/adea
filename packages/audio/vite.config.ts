import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

const srcRoot = fileURLToPath(new URL('./src', import.meta.url))

/** Every module in `src`, so `preserveModules` mirrors the published tree. */
function sourceEntries(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceEntries(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

/**
 * The library build compiles the Solid JSX to `solid-js/web` template calls, so
 * the published `dist` runs in Node, Bun, and any bundler. Declarations come
 * from `tsc --emitDeclarationOnly` (see the build script).
 */
export default defineConfig({
  plugins: [solid()],
  build: {
    target: 'es2022',
    sourcemap: false,
    minify: false,
    lib: {
      entry: sourceEntries(srcRoot),
      formats: ['es'],
    },
    rollupOptions: {
      // Workspace packages stay external: consumers resolve their own copies.
      // `#`-prefixed ids are this package's own `imports` aliases, so they are
      // bundled and rewritten to relative specifiers.
      external: (id) =>
        !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('#') && !id.startsWith('\0'),
      output: {
        entryFileNames: '[name].js',
        format: 'es',
        preserveModules: true,
        preserveModulesRoot: srcRoot,
      },
    },
  },
})
