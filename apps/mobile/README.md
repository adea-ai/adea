# Agent HQ Mobile

The mobile target is a thin Capacitor shell around the canonical web
application. The React application, domain logic, data contracts, state, UI,
and Three.js runtime are shared with `apps/web`.

Set `ADEA_WEB_URL` to the deployed web origin before running `bun run sync`
or opening a native platform. Native plugins belong here as focused capability
adapters; the web app remains the only owner of UI, state, data, and scenes.
