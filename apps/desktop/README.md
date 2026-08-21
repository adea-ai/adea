# Agent HQ Desktop

The desktop target is a thin Tauri 2 native shell around the canonical web
application. React, application state, data access, and the Three.js scene
runtime remain in the shared workspace packages and `apps/web`.

Run `AGENT_HQ_WEB_URL=http://localhost:3004 bun run dev` from this directory to
open the local web app in the Tauri shell. Production builds should set
`AGENT_HQ_WEB_URL` to the deployed web origin.
