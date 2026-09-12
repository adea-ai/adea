// Bench Tauri-compat shim: presents the minimal window.__TAURI_INTERNALS__
// surface the unmodified desktop client expects, routing invoke() to the
// shell's main process. Runs with contextIsolation:false so this lands in the
// page's main world. Bench-only — deleted by #371.
const { ipcRenderer } = require('electron')

window.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
  plugins: {},
  transformCallback: function (cb) {
    var id = (window.__benchNextCbId = (window.__benchNextCbId || 0) + 1)
    window['__bench_cb_' + id] = cb
    return id
  },
  invoke: function (cmd, args) {
    console.warn('[adea-shim] invoke', cmd)
    return ipcRenderer.invoke('adea-shim:invoke', { cmd: cmd, args: args })
  },
}

window.benchPing = () => ipcRenderer.invoke('ping')
