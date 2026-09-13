// Ambient shape of the Electrobun main-process API the shell uses. Electrobun
// 2.0.1 ships its runtime through Hutch (no npm-bundled type definitions), so
// the shell declares the narrow surface it calls: one CEF window bound to the
// loopback URL. Keep this minimal — a wider declaration would typecheck code
// the shell does not use.
declare module 'electrobun/main' {
  export type BrowserWindowOptions = {
    title?: string
    url?: string
    frame?: { width?: number; height?: number; x?: number; y?: number }
  }
  export class BrowserWindow {
    constructor(options: BrowserWindowOptions)
    close(): void
  }
}
