# Adea Mobile

The mobile target is a thin Capacitor shell around the canonical web
application. The React application, domain logic, data contracts, state, and
UI are shared with `apps/web`. The 3D scenes live in the private Agent Sim
engine and are unavailable in this shell.

Set `ADEA_WEB_URL` to the deployed web origin before running `bun run sync`
or opening a native platform. Native plugins belong here as focused capability
adapters; the web app remains the only owner of UI, state, and data.
