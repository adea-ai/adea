import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

const srcRoot = fileURLToPath(new URL('./src', import.meta.url))

function sourceEntries(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceEntries(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

export default defineConfig({
  plugins: [solid()],
  build: {
    target: 'es2022',
    sourcemap: false,
    minify: false,
    lib: { entry: sourceEntries(srcRoot), formats: ['es'] },
    rollupOptions: {
      external: (id) => !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('\0'),
      output: {
        entryFileNames: '[name].js',
        format: 'es',
        preserveModules: true,
        preserveModulesRoot: srcRoot,
      },
    },
  },
})
