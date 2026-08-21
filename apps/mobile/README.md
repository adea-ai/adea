# Agent HQ Mobile

The mobile target is a thin Capacitor shell around the canonical web
application. The React application, domain logic, data contracts, state, UI,
and Three.js runtime are shared with `apps/web`.

Set `AGENT_HQ_WEB_URL` to the deployed web origin before running `bun run sync`
or opening a native platform. Native plugins should be added here as focused
capability adapters rather than duplicated application features.
