import { defineConfig } from 'vite-plus'

// Opt-in Vite+ proof lane (see docs/vite-plus-proof.md). Turbo stays the
// required task runner; nothing here changes `bun run build|test|lint`.
//
// These tasks run through Bun (`bun test`) or a native compiler, and Vite
// Task's automatic file tracking does not see files Bun loads itself. Every
// task therefore lists its inputs explicitly instead of relying on `auto`,
// and fingerprints a toolchain id (node, bun, vp, platform) because Vite Task
// does not hash the binaries that run a task.

type Pkg = { dir: string; deps: string[]; test: string }

// Dependency order matters: a package's tasks wait for its workspace
// dependencies' builds, whose `dist` it reads.
const packages: Record<string, Pkg> = {
  types: { dir: 'types', deps: [], test: 'bun test tests' },
  state: { dir: 'state', deps: ['types'], test: 'bun test tests' },
  'api-client': { dir: 'api-client', deps: ['types'], test: 'bun test tests/unit' },
  'app-core': { dir: 'app-core', deps: ['types'], test: 'bun test ./test' },
  auth: { dir: 'auth', deps: ['types'], test: 'bun test tests/unit' },
  spatial: { dir: 'spatial', deps: [], test: 'bun test ./test' },
}

const toolchain = 'ADEA_VP_TOOLCHAIN'

const workspace = (pattern: string) => ({ pattern, base: 'workspace' as const })

const shared = [
  'package.json',
  'bun.lock',
  'bunfig.toml',
  'tsconfig.json',
  'tsconfig.base.json',
  'packages/config/**',
  'vite.config.ts',
].map(workspace)

// Bun and tsc read each workspace dependency through its built output.
const dependencyInputs = (pkg: Pkg) =>
  pkg.deps.flatMap((dep) => [
    workspace(`packages/${packages[dep].dir}/dist/**`),
    workspace(`packages/${packages[dep].dir}/package.json`),
  ])

// tsc only reads `src` (tsconfig `include`), so tests do not invalidate builds.
const buildInputs = (pkg: Pkg) => [
  { auto: true },
  workspace(`packages/${pkg.dir}/src/**`),
  workspace(`packages/${pkg.dir}/tsconfig.json`),
  workspace(`packages/${pkg.dir}/package.json`),
  ...dependencyInputs(pkg),
  ...shared,
]

// Bun-run tests list their inputs explicitly: automatic tracking is not
// relied on for anything Bun loads (test files, sources, data, dependency
// builds), and the lockfile stands in for installed third-party code.
const testInputs = (pkg: Pkg) => [
  workspace(`packages/${pkg.dir}/**`),
  workspace(`!packages/${pkg.dir}/dist/**`),
  workspace(`!packages/${pkg.dir}/node_modules/**`),
  workspace(`!packages/${pkg.dir}/**/*.tsbuildinfo`),
  ...dependencyInputs(pkg),
  ...shared,
]

const tasks: Record<string, unknown> = {}
for (const [name, pkg] of Object.entries(packages)) {
  const cwd = `packages/${pkg.dir}`
  tasks[`${name}:build`] = {
    command: 'tsc -p tsconfig.json',
    cwd,
    dependsOn: pkg.deps.map((dep) => `${dep}:build`),
    cache: {
      env: [toolchain],
      input: buildInputs(pkg),
      output: ['dist/**', '!**/*.tsbuildinfo'],
    },
  }
  tasks[`${name}:test`] = {
    command: pkg.test,
    cwd,
    dependsOn: [`${name}:build`],
    cache: {
      env: [toolchain],
      input: testInputs(pkg),
      output: [],
    },
  }
}

// Control: the same Bun test with automatic tracking only. It exists to show
// what the explicit globs above are for and is excluded from `proof`.
tasks['control:types-test-auto-only'] = {
  command: packages.types.test,
  cwd: 'packages/types',
  dependsOn: ['types:build'],
  cache: { env: [toolchain], input: [{ auto: true }], output: [] },
}

tasks.proof = {
  command: 'node -e "console.log(\'vite-plus proof lane complete\')"',
  dependsOn: Object.keys(packages).flatMap((name) => [`${name}:build`, `${name}:test`]),
  cache: false,
}

export default defineConfig({
  run: {
    cache: { scripts: false, tasks: true },
    tasks,
  },
})
