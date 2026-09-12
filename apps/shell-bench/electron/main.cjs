// shell-bench Electron parity shell. Loads whatever URL is passed as --url=...
// and exposes a minimal ping bridge for the IPC probe. Nothing else.
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')

function targetUrl() {
  const arg = process.argv.find((a) => a.startsWith('--url='))
  return arg ? arg.slice(6) : 'about:blank'
}

app.whenReady().then(() => {
  ipcMain.handle('ping', () => 'pong')
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.loadURL(targetUrl())
})

app.on('window-all-closed', () => app.quit())
