# shell-bench (M5.2 evaluation harness — disposable)

Parity desktop shells that wrap the real `apps/desktop` web client build to
benchmark engine-bundling shell candidates for the M5 decision
(`docs/decisions/0006-browser-lanes-and-desktop-shell.md`, issue #369).

**Everything in this directory is throwaway.** #371 (M5.4) deletes the whole
`apps/shell-bench/` tree, its `results/` artifacts, and any generated
lockfiles/node_modules inside it once the milestone closes. None of it is a
workspace member (bench `package.json` files live at depth 2 so the root
workspace glob `apps/*` never sees them) and none of it touches the root
lockfile.

## Layout

| Path | What it is |
| --- | --- |
| `runner/run-bench.mjs` | Orchestrator: serves `apps/desktop/dist` + probe pages, launches candidates sequentially, samples RSS, writes `results/` |
| `bench/probe.html` | IPC round-trip probe (autodetects the shell bridge) |
| `bench/inject.js` | Ready beacon the runner injects into the served client (NavigationTiming → POST) |
| `electron/` | Electron parity shell (`main.cjs` + sandboxed preload + `electron-builder --dir` app bundle) |
| `tauri/` | Minimal Tauri 2 parity shell (baseline; `ping` command, external-URL window) |
| `nwjs/` | NW.js longshot shell (redirect page) |
| `cef/` | CEF-in-Rust parity shell (primary candidate — vendored from tauri-apps/cef-rs `cefsimple`; bundled via `CEF_PATH=<dist> bundle-cef-app shell-bench-cef -o target/bundle`) |
| `electrobun/` | Electrobun bootstrap + two generated projects (not committed — regenerate below) |
| `results/` | Raw benchmark output (JSON + markdown), gitignored in M5.4 cleanup |

Chrome `--app` mode needs no harness directory — the runner launches the
installed Chrome binary directly with a throwaway profile.

### Regenerating the Electrobun variants

The generated projects are gitignored (template scaffolding). Recreate with:

```sh
cd apps/shell-bench/electrobun
bun add electrobun
./node_modules/.bin/electrobun init shell-bench-electrobun-bun --template=hello-world
./node_modules/.bin/electrobun init shell-bench-electrobun-rust --template=rust-flock-wgpu
```

Then patch one line in `shell-bench-electrobun-bun/src/bun/index.ts` so the
window honors the bench URL:

```ts
url: process.env.BENCH_URL ?? "views://mainview/index.html",
```

Build each with `hutch run build` (requires `~/.hutch/bin` on PATH — the first
`electrobun init` installs it).

## Run

```sh
bun runner/run-bench.mjs --only electron,tauri,nwjs,chrome
bun runner/run-bench.mjs --sizes-only
```
