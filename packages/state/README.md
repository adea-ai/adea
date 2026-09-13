# State package

Owns the Solid workspace store (`solid-js/store`) for ephemeral, client-only
workspace coordination such as panel visibility and transient scene controls.
Consumers select fields with `useWorkspaceState`; backend data remains in
TanStack Query's Solid bindings.
