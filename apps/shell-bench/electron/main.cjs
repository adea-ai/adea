// shell-bench Electron parity shell: loads --url=..., provides the bench
// Tauri-compat bridge (file-backed vaults, benign stubs) so the unmodified
// desktop client can boot a guest workspace. Disposable — deleted by #371.
const { app, BrowserWindow, ipcMain } = require('electron')
const { safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const STATE_DIR = path.join(app.getPath('userData'), 'bench-state')
function stateFile(name) {
  return path.join(STATE_DIR, name)
}
function readJson(name) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(name), 'utf8'))
  } catch {
    return null
  }
}
function writeJson(name, value) {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  fs.writeFileSync(stateFile(name), JSON.stringify(value ?? null))
}
function clearFile(name) {
  try {
    fs.rmSync(stateFile(name))
  } catch {
    /* absent */
  }
}

// Secrets (sessions, credentials) get safeStorage encryption when available.
function encrypt(value) {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(JSON.stringify(value ?? null)).toString('base64')
  }
  return JSON.stringify(value ?? null)
}
function decrypt(blob) {
  try {
    const parsed = JSON.parse(blob)
    if (typeof parsed === 'string') return null // not encrypted marker
    return null
  } catch {
    return null
  }
}

function targetUrl() {
  const arg = process.argv.find((a) => a.startsWith('--url='))
  return arg ? arg.slice(6) : 'about:blank'
}

// The 27-command desktop surface (see #369 enumeration). Boot-critical ones
// are file/safeStorage-backed; the rest return benign stubs.
const handlers = {
  desktop_user_session_load: () => {
    try {
      const raw = fs.readFileSync(stateFile('session.bin'))
      return JSON.parse(safeStorage.decryptString(Buffer.from(raw.toString('utf8'), 'base64')))
    } catch {
      return null
    }
  },
  desktop_user_session_save: (a) => {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(stateFile('session.bin'), encrypt(a))
    return null
  },
  desktop_user_session_clear: () => {
    try {
      fs.rmSync(stateFile('session.bin'))
    } catch {
      /* absent */
    }
    return null
  },
  desktop_auth_attempt_load: () => readJson('auth-attempt.json'),
  desktop_auth_attempt_save: (a) => (writeJson('auth-attempt.json', a), null),
  desktop_auth_attempt_clear: () => (clearFile('auth-attempt.json'), null),
  desktop_auth_start: () => null,
  desktop_auth_take_callback: () => null,
  desktop_temporary_workspace_load: () => readJson('temporary-workspace.json'),
  desktop_temporary_workspace_save: (a) => (writeJson('temporary-workspace.json', a), null),
  desktop_temporary_workspace_clear: () => (clearFile('temporary-workspace.json'), null),
  desktop_preferences_load: () => readJson('preferences.json'),
  desktop_preferences_save: (a) => (writeJson('preferences.json', a), null),
  local_content_authorize_workspace: () => null,
  local_content_create: () => null,
  local_content_read: () => null,
  local_content_update: () => null,
  local_content_delete: () => null,
  local_content_search: () => [],
  local_content_health: () => ({ ok: true }),
  local_content_rotate_key: () => null,
  desktop_update_check: () => ({ upToDate: true }),
  desktop_update_status: () => ({ upToDate: true }),
  desktop_update_install: () => null,
  desktop_transcription_permission: () => 'denied',
  desktop_transcription_start: () => {
    throw new Error('transcription unavailable in bench shell')
  },
  desktop_transcription_cancel: () => null,
}

app.whenReady().then(() => {
  ipcMain.handle('ping', () => 'pong')
  ipcMain.handle('adea-shim:invoke', (_event, payload) => {
    const handler = handlers[payload.cmd]
    if (!handler) {
      console.warn('[adea-shim] unhandled command:', payload.cmd)
      return null
    }
    return handler(payload.args)
  })

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'tauri-shim.cjs'),
      sandbox: false,
      contextIsolation: false,
      nodeIntegration: false,
    },
  })
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    fs.appendFileSync(
      '/tmp/electron-client-console.log',
      `[${level}] ${message} (${sourceId}:${line})\n`
    )
  })
  win.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      win.webContents
        .capturePage()
        .then((img) => fs.writeFileSync('/tmp/electron-screen.png', img.toPNG()))
        .catch(() => {})
    }, 12000)
  })
  win.loadURL(targetUrl())
})

app.on('window-all-closed', () => app.quit())
