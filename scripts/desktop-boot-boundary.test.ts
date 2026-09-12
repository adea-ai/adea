import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const shell = join(root, 'apps/desktop/src-tauri/src')

// The boot pipeline's own tests live in `boot.rs` and run under `cargo test`
// (see `.github/workflows/desktop-shell.yml`). These assertions pin the parts a
// Rust unit test cannot: that the composition root has no panic path, and that
// the failure taxonomy keeps its promise of guidance plus a retry policy.
describe('desktop boot pipeline', () => {
  test('keeps the entry point free of panic paths', async () => {
    const main = await readFile(join(shell, 'main.rs'), 'utf8')
    const boot = await readFile(join(shell, 'boot.rs'), 'utf8')

    expect(main).not.toContain('.expect(')
    expect(main).not.toContain('.unwrap(')
    expect(main).not.toContain('panic!')
    expect(boot).not.toContain('.unwrap(')
    expect(boot).not.toContain('panic!')
    // Startup is owned by `boot`, not by the builder chain.
    expect(main).toContain('boot::launch(')
    expect(main).toContain('.setup(boot::install)')
    expect(main).not.toContain('WebviewWindowBuilder')
  })

  test('classifies every startup failure with guidance and a retry policy', async () => {
    const boot = await readFile(join(shell, 'boot.rs'), 'utf8')

    expect(boot).toContain('pub enum BootFailureKind')
    for (const kind of [
      'IncompleteBundle',
      'DataDirUnavailable',
      'NativeServiceUnavailable',
      'WebviewFailure',
    ]) {
      expect(boot).toContain(kind)
    }
    expect(boot).toContain('pub fn retryable')
    // A data directory that cannot be written must not be retried into a loop.
    expect(boot).toContain('Self::DataDirUnavailable => false')
    // Retries are bounded, and a retryable failure asks the user first.
    expect(boot).toContain('MAX_BOOT_ATTEMPTS')
    expect(boot).toContain('fn confirm_retry')
    expect(boot).toContain('MessageButtons::OkCancelCustom')
    expect(boot).toContain('"Retry".to_string()')
    expect(boot).toContain('"Quit".to_string()')
  })

  test('persists the launch log outside the app bundle', async () => {
    const boot = await readFile(join(shell, 'boot.rs'), 'utf8')
    const config = JSON.parse(
      await readFile(join(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8')
    ) as { identifier: string }

    expect(boot).toContain("const LAUNCH_LOG_FILENAME: &str = \"launch-log.jsonl\"")
    expect(boot).toContain("const LOG_DIRECTORY_NAME: &str = \"com.adea.desktop\"")
    // The log directory is derived from the bundle identifier, so the record
    // survives a reinstall of the same product.
    expect(config.identifier).toBe('com.adea.desktop')
    expect(boot).toContain('LaunchEvent::Started')
    expect(boot).toContain('LaunchEvent::Ready')
    expect(boot).toContain('LaunchEvent::Exited')
    expect(boot).toContain('MAX_LAUNCH_RECORDS')
  })

  test('opens the main window only after the boot steps pass', async () => {
    const boot = await readFile(join(shell, 'boot.rs'), 'utf8')
    const startBody = boot.slice(boot.indexOf('fn start<R: Runtime>'), boot.indexOf('fn create_main_window'))
    const order = [
      'verify_bundled_assets(app)?',
      'prepare_writable_directories(app)?',
      'register_native_services(app)?',
      'initialize_local_content(app)?',
      'create_main_window(app)',
    ]

    let cursor = -1
    for (const step of order) {
      const index = startBody.indexOf(step)
      expect(index).toBeGreaterThan(cursor)
      cursor = index
    }
  })

  test('serves the auth callback channel and updater from the boot pipeline', async () => {
    const boot = await readFile(join(shell, 'boot.rs'), 'utf8')
    const auth = await readFile(join(shell, 'auth.rs'), 'utf8')

    expect(boot).toContain('tauri_plugin_updater::Builder::new().build()')
    expect(boot).toContain('crate::auth::start_deep_link_channel(app)')
    expect(auth).toContain('pub fn start_deep_link_channel')
    expect(auth).toContain('pub fn receive_auth_callback')
    // The shell must recover from a failure to create its window, so the
    // window builder cannot be constructed outside the typed step list.
    expect(boot).toContain('fn create_main_window')
  })
})
