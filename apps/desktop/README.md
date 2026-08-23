# Agent HQ Desktop

The desktop target is a thin Tauri 2 native shell around the canonical web
application. React, application state, data access, and the Three.js scene
runtime remain in the shared workspace packages and `apps/web`.

Run `bun run shell:dev` from this directory to open the local web app in the
Tauri shell. Debug builds default to `http://127.0.0.1:3004`; release builds
default to `https://agent-hq-site.vercel.app`. Set `AGENT_HQ_WEB_URL` to
override either default when testing another deployed web origin. The shell
owns only native capabilities; the web app owns UI, state, data, and the
Three.js scene runtime.
