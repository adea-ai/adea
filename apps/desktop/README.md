# Agent HQ Desktop

The desktop target is a thin Tauri 2 native shell around the canonical web
application. React, application state, data access, and the Three.js scene
runtime remain in the shared workspace packages and `apps/web`.

Run `bun run shell:dev` from this directory to open the local web app in the
Tauri shell. The default local URL is `http://127.0.0.1:3004`; set
`AGENT_HQ_WEB_URL` to a deployed web origin for production builds. The shell
owns only native capabilities; the web app owns UI, state, data, and the
Three.js scene runtime.
