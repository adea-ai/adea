import { spawnSync } from 'node:child_process'

// Runs the Playwright half of the E2E lane after scripts/e2e-setup.mjs has
// prepared the database. When the Code Foundry E2E lane fans out into shards
// (E2E_TOTAL_SHARDS > 1), the main spec run is partitioned with Playwright's
// native --shard so each runner executes a slice of the suite against its own
// runner-local database. Without shard variables the invocation is unchanged.
const specs = [
  'apps/web/e2e/workspace-guest.spec.ts',
  'apps/web/e2e/sidebar-resize.spec.ts',
  'apps/web/e2e/cursor-check.spec.ts',
  'apps/web/e2e/dev-view.spec.ts',
  'apps/web/e2e/dev-view-files-tree.spec.ts',
  'apps/web/e2e/dev-add-project.spec.ts',
  'apps/web/e2e/appearance.spec.ts',
  'apps/web/e2e/dev-view-permissions.spec.ts',
  'apps/web/e2e/chat-transcript-composition.spec.ts',
  'apps/web/e2e/desktop-runtime-chat.spec.ts',
  'apps/web/e2e/desktop-first-run-chat.spec.ts',
  'apps/web/e2e/plugins-loading.spec.ts',
  'apps/web/e2e/workspace-form.spec.ts',
  'apps/web/e2e/dev-browser-pane.spec.ts',
  'apps/web/e2e/workspace-tooltip.spec.ts',
  'apps/web/e2e/workspace-menu.spec.ts',
  'apps/web/e2e/workspace-loading.spec.ts',
  'apps/web/e2e/private-message.spec.ts',
  'apps/web/e2e/desktop-chat-presentation.spec.ts',
  'apps/web/e2e/workspace-navigation-presentation.spec.ts',
  'apps/web/e2e/workspace-updates.spec.ts',
  'apps/web/e2e/workspace-platform-boundary.spec.ts',
  'apps/web/e2e/version-dialog.spec.ts',
]

const total = process.env.E2E_TOTAL_SHARDS === undefined ? 1 : Number(process.env.E2E_TOTAL_SHARDS)
const index = process.env.E2E_SHARD_INDEX === undefined ? 1 : Number(process.env.E2E_SHARD_INDEX)
if (!Number.isInteger(total) || total < 1) {
  console.error(`Unsupported E2E_TOTAL_SHARDS: ${process.env.E2E_TOTAL_SHARDS}`)
  process.exit(1)
}
if (!Number.isInteger(index) || index < 1 || (total > 1 && index > total)) {
  console.error(`Unsupported E2E_SHARD_INDEX ${process.env.E2E_SHARD_INDEX} for ${total} shard(s)`)
  process.exit(1)
}
const shardArgs = total > 1 ? ['--shard', `${index}/${total}`] : []

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`)
  }
}

run('bunx', ['playwright', 'install', '--with-deps', 'chromium'])
run('bunx', ['turbo', 'run', 'build', '--filter=@adea-ai/web^...'])
run('playwright', ['test', '--config=playwright.config.ts', ...shardArgs, ...specs])

// The event-listener regression probe is a single test. Running it once (on
// shard 1 when sharded) keeps today's semantics exactly; it never depended on
// the main spec slice.
if (total === 1 || index === 1) {
  run('playwright', [
    'test',
    '--config=playwright.config.ts',
    'apps/web/e2e/conventional-workspace.spec.ts',
    '--grep',
    'repeated Chat and Library transitions release workspace event listeners',
  ])
}
