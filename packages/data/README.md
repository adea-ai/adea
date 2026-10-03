# Data package

Owns TanStack Query providers, cache keys, and server-state hooks for workspaces,
agents, tasks, and messages.

Optimistic task mutations serialize writes to each task version while allowing different
cards to update concurrently. They roll back only their own unchanged row, retain newer writes,
and defer list reconciliation until the latest pending card writes settle. Successful
creates enter the cached list before the create panel closes; older responses cannot
replace a newer server version in either the list or detail cache.
