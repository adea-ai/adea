import { describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const updaterModule = new URL('../shell/src/updater.ts', import.meta.url).href
const stubbedCommands = ['ditto', 'mv', 'open', 'pgrep', 'pkill', 'rm', 'sleep'] as const

type Mode = 'full' | 'slim'

type SwapFixture = Readonly<{
  root: string
  target: string
  previous: string
  payloadDir: string
  newAppPath: string
  scriptPath: string
}>

function writeBundle(bundle: string, marker: string, includeRuntime: boolean): void {
  const resources = join(bundle, 'Contents', 'Resources')
  mkdirSync(join(resources, 'app', 'client'), { recursive: true })
  writeFileSync(join(resources, 'main.js'), `// ${marker}`)
  writeFileSync(join(resources, 'app', 'client', 'index.html'), marker)
  writeFileSync(join(resources, 'app', 'bun'), `bun-${marker}`)

  if (includeRuntime) {
    const macos = join(bundle, 'Contents', 'MacOS')
    const framework = join(
      bundle,
      'Contents',
      'Frameworks',
      'Chromium Embedded Framework.framework'
    )
    mkdirSync(macos, { recursive: true })
    mkdirSync(framework, { recursive: true })
    writeFileSync(join(macos, 'launcher'), `launcher-${marker}`)
    writeFileSync(join(framework, 'Chromium Embedded Framework'), `cef-${marker}`)
  }
}

function makeFixture(mode: Mode): SwapFixture {
  const root = mkdtempSync(join(tmpdir(), 'adea updater swap '))
  const target = join(root, 'Installed Adea.app')
  const previous = `${target}.previous`
  const payloadDir = join(root, 'payload')
  const newAppPath = join(payloadDir, 'Adea.app')
  const dataDir = join(root, 'data')
  mkdirSync(join(dataDir, 'updates'), { recursive: true })
  mkdirSync(payloadDir, { recursive: true })
  writeBundle(target, 'old-install', true)
  writeBundle(newAppPath, 'new-install', mode === 'full')
  if (mode === 'full') writeBundle(previous, 'stale-backup', true)

  const request = {
    newAppPath,
    dataDir,
    execPath: join(target, 'Contents', 'MacOS', 'launcher'),
    mode,
  }
  // The apply script waits for the process that staged it to exit. Stage in a
  // short-lived Bun child so the fixture can execute the exact generated file.
  const childCode = [
    `import { stageUpdateSwap } from ${JSON.stringify(updaterModule)}`,
    `const result = stageUpdateSwap(${JSON.stringify(request)})`,
    `if ('error' in result) throw new Error(result.error)`,
    `console.log(JSON.stringify(result))`,
  ].join('\n')
  const staged = Bun.spawnSync([process.execPath, '-e', childCode], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (staged.exitCode !== 0) {
    throw new Error(`could not stage updater fixture: ${staged.stderr.toString()}`)
  }
  const result = JSON.parse(staged.stdout.toString()) as { scriptPath?: string }
  if (!result.scriptPath) throw new Error('updater fixture did not return an apply script')

  return { root, target, previous, payloadDir, newAppPath, scriptPath: result.scriptPath }
}

const commandStub = `#!/bin/sh
set -u
name=$(basename "$0")
printf '%s|%s\\n' "$name" "$*" >> "$TRACE_FILE"

if [ "$name" = "rm" ] && [ "$1" = "-rf" ] && [ "$2" = "$PREVIOUS" ]; then
  count=0
  if [ -f "$PREVIOUS_REMOVE_COUNT" ]; then read -r count < "$PREVIOUS_REMOVE_COUNT"; fi
  count=$((count + 1))
  printf '%s\\n' "$count" > "$PREVIOUS_REMOVE_COUNT"
  if [ "$FAIL_AT" = "backup_cleanup" ] && [ "$count" -eq 1 ]; then exit 70; fi
  if [ "$FAIL_AT" = "retirement" ] && [ "$count" -eq 2 ]; then exit 71; fi
fi

if [ "$name" = "rm" ] && [ "$1" = "-rf" ] && [ "$2" = "$PAYLOAD_DIR" ] && [ "$FAIL_AT" = "payload_cleanup" ]; then exit 72; fi

if [ "$name" = "mv" ]; then
  if [ "$FAIL_AT" = "backup_move" ] && [ "$1" = "$TARGET" ] && [ "$2" = "$PREVIOUS" ]; then exit 73; fi
  if [ "$FAIL_AT" = "replacement_move" ] && [ "$1" = "$NEW_APP" ] && [ "$2" = "$TARGET" ]; then exit 74; fi
  if [ "$FAIL_AT" = "rollback_move" ]; then
    if { [ "$1" = "$NEW_APP" ] && [ "$2" = "$TARGET" ]; } || { [ "$1" = "$PREVIOUS" ] && [ "$2" = "$TARGET" ]; }; then exit 75; fi
  fi
fi

case "$name" in
  pkill|pgrep) exit 1 ;;
  sleep) exit 0 ;;
  ditto)
    if [ "$FAIL_AT" = "slim_partial" ]; then
      mkdir -p "$2/Contents/Resources/app/client"
      printf 'partial' > "$2/Contents/Resources/app/client/index.html"
      exit 77
    fi
    mkdir -p "$2"
    exec /bin/cp -R "$1"/. "$2"/
    ;;
  open) [ "$FAIL_AT" = "launch" ] && exit 76; exit 0 ;;
  rm) exec /bin/rm "$@" ;;
  mv) exec /bin/mv "$@" ;;
  *) exit 127 ;;
esac
`

function runApply(fixture: SwapFixture, failAt = 'none') {
  const binDir = join(fixture.root, 'bin')
  const stubPath = join(binDir, 'fixture-command')
  const traceFile = join(fixture.root, 'commands.log')
  mkdirSync(binDir)
  writeFileSync(stubPath, commandStub)
  chmodSync(stubPath, 0o755)
  for (const command of stubbedCommands) symlinkSync('fixture-command', join(binDir, command))

  const result = Bun.spawnSync([fixture.scriptPath], {
    cwd: fixture.root,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      TRACE_FILE: traceFile,
      FAIL_AT: failAt,
      TARGET: fixture.target,
      PREVIOUS: fixture.previous,
      NEW_APP: fixture.newAppPath,
      PAYLOAD_DIR: fixture.payloadDir,
      PREVIOUS_REMOVE_COUNT: join(fixture.root, 'previous-remove-count'),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: result.exitCode,
    trace: existsSync(traceFile) ? readFileSync(traceFile, 'utf8').trim().split('\n') : [],
  }
}

function cleanup(fixture: SwapFixture): void {
  rmSync(fixture.root, { recursive: true, force: true })
}

function bundleContentMarker(bundle: string): string {
  return readFileSync(join(bundle, 'Contents', 'Resources', 'main.js'), 'utf8')
}

function didRun(trace: readonly string[], command: string): boolean {
  return trace.some((entry) => entry.startsWith(`${command}|`))
}

describe('executed updater apply script', () => {
  test('full swap replaces the app, retires the backup and payload, then launches', () => {
    const fixture = makeFixture('full')
    try {
      const script = readFileSync(fixture.scriptPath, 'utf8')
      expect(script.split('\n')[1]).toBe('set -eu')
      expect(statSync(fixture.scriptPath).mode & 0o111).not.toBe(0)

      const result = runApply(fixture)
      expect(result.exitCode).toBe(0)
      expect(bundleContentMarker(fixture.target)).toContain('new-install')
      expect(existsSync(fixture.previous)).toBe(false)
      expect(existsSync(fixture.payloadDir)).toBe(false)
      expect(didRun(result.trace, 'open')).toBe(true)
    } finally {
      cleanup(fixture)
    }
  })

  test('slim overlay preserves runtime files and launches after copying the app layer', () => {
    const fixture = makeFixture('slim')
    try {
      const result = runApply(fixture)
      expect(result.exitCode).toBe(0)
      expect(
        readFileSync(
          join(fixture.target, 'Contents', 'Resources', 'app', 'client', 'index.html'),
          'utf8'
        )
      ).toBe('new-install')
      expect(readFileSync(join(fixture.target, 'Contents', 'MacOS', 'launcher'), 'utf8')).toBe(
        'launcher-old-install'
      )
      expect(
        readFileSync(
          join(
            fixture.target,
            'Contents',
            'Frameworks',
            'Chromium Embedded Framework.framework',
            'Chromium Embedded Framework'
          ),
          'utf8'
        )
      ).toBe('cef-old-install')
      expect(existsSync(fixture.payloadDir)).toBe(false)
      expect(didRun(result.trace, 'open')).toBe(true)
    } finally {
      cleanup(fixture)
    }
  })

  test('a failed partial slim ditto keeps its payload and does not launch', () => {
    const fixture = makeFixture('slim')
    try {
      const result = runApply(fixture, 'slim_partial')
      expect(result.exitCode).not.toBe(0)
      expect(
        readFileSync(
          join(fixture.target, 'Contents', 'Resources', 'app', 'client', 'index.html'),
          'utf8'
        )
      ).toBe('partial')
      expect(readFileSync(join(fixture.target, 'Contents', 'MacOS', 'launcher'), 'utf8')).toBe(
        'launcher-old-install'
      )
      expect(existsSync(fixture.payloadDir)).toBe(true)
      expect(didRun(result.trace, 'open')).toBe(false)
    } finally {
      cleanup(fixture)
    }
  })

  test('a stale-backup cleanup failure leaves the installed app untouched', () => {
    const fixture = makeFixture('full')
    try {
      const result = runApply(fixture, 'backup_cleanup')
      expect(result.exitCode).not.toBe(0)
      expect(bundleContentMarker(fixture.target)).toContain('old-install')
      expect(bundleContentMarker(fixture.previous)).toContain('stale-backup')
      expect(existsSync(fixture.payloadDir)).toBe(true)
      expect(didRun(result.trace, 'open')).toBe(false)
    } finally {
      cleanup(fixture)
    }
  })

  test('a backup move failure stops before replacement or launch', () => {
    const fixture = makeFixture('full')
    try {
      const result = runApply(fixture, 'backup_move')
      expect(result.exitCode).not.toBe(0)
      expect(bundleContentMarker(fixture.target)).toContain('old-install')
      expect(existsSync(fixture.previous)).toBe(false)
      expect(existsSync(fixture.payloadDir)).toBe(true)
      expect(didRun(result.trace, 'open')).toBe(false)
    } finally {
      cleanup(fixture)
    }
  })

  test('a failed replacement move restores the previous app and retains the payload', () => {
    const fixture = makeFixture('full')
    try {
      const result = runApply(fixture, 'replacement_move')
      expect(result.exitCode).not.toBe(0)
      expect(bundleContentMarker(fixture.target)).toContain('old-install')
      expect(existsSync(fixture.previous)).toBe(false)
      expect(existsSync(fixture.payloadDir)).toBe(true)
      expect(didRun(result.trace, 'open')).toBe(false)
    } finally {
      cleanup(fixture)
    }
  })

  test('a failed rollback leaves the previous bundle for recovery and does not launch', () => {
    const fixture = makeFixture('full')
    try {
      const result = runApply(fixture, 'rollback_move')
      expect(result.exitCode).not.toBe(0)
      expect(existsSync(fixture.target)).toBe(false)
      expect(bundleContentMarker(fixture.previous)).toContain('old-install')
      expect(existsSync(fixture.payloadDir)).toBe(true)
      expect(didRun(result.trace, 'open')).toBe(false)
    } finally {
      cleanup(fixture)
    }
  })

  test('a backup retirement failure keeps the old backup and stops before cleanup or launch', () => {
    const fixture = makeFixture('full')
    try {
      const result = runApply(fixture, 'retirement')
      expect(result.exitCode).not.toBe(0)
      expect(bundleContentMarker(fixture.target)).toContain('new-install')
      expect(bundleContentMarker(fixture.previous)).toContain('old-install')
      expect(existsSync(fixture.payloadDir)).toBe(true)
      expect(didRun(result.trace, 'open')).toBe(false)
    } finally {
      cleanup(fixture)
    }
  })

  test('a payload cleanup failure stops before launch after the full swap', () => {
    const fixture = makeFixture('full')
    try {
      const result = runApply(fixture, 'payload_cleanup')
      expect(result.exitCode).not.toBe(0)
      expect(bundleContentMarker(fixture.target)).toContain('new-install')
      expect(existsSync(fixture.previous)).toBe(false)
      expect(existsSync(fixture.payloadDir)).toBe(true)
      expect(didRun(result.trace, 'open')).toBe(false)
    } finally {
      cleanup(fixture)
    }
  })

  test('a launch failure is returned as a script failure after the payload is retired', () => {
    const fixture = makeFixture('full')
    try {
      const result = runApply(fixture, 'launch')
      expect(result.exitCode).not.toBe(0)
      expect(bundleContentMarker(fixture.target)).toContain('new-install')
      expect(existsSync(fixture.previous)).toBe(false)
      expect(existsSync(fixture.payloadDir)).toBe(false)
      expect(didRun(result.trace, 'open')).toBe(true)
    } finally {
      cleanup(fixture)
    }
  })
})
