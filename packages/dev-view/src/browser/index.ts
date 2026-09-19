// The browser barrel is consumed eagerly by the desktop provider adapter
// (desktop-dev-runtime), so it must not re-export pane implementations:
// BrowserPane and MiniPreview ride the lazy Dev chunk through the entry's
// relative imports only (see the client-budget boundary check).
export * from './annotation-model'
export * from './command'
export * from './mini-preview-layout'
export * from './ports-model'
export * from './responsive-presets'
