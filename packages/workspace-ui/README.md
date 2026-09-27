# @adea-ai/workspace-ui

Workspace presentation layer: conventional (chat) workspace shell, roster,
conversation surface, task board, marketplace and plugin dialogs, global rail,
settings, and the `VirtualUnavailable` fallback rendered wherever the private
engine view mounts. Consumes `@adea-ai/data` and `@adea-ai/state`; never
imports engine packages directly.

## Global rail

The `GlobalWorkspaceRail` stays mounted across workspace views. Ctrl/Cmd+K
calls its host-owned `onOpenSearch` action, so the host can open Chat search or
focus the App Library search when Chat is disabled. Workspace selection uses
the published dropdown radio menu: arrow keys move between workspaces, Enter
selects one, and Escape closes the menu and restores focus to its trigger.

## Loading state

`WorkspaceSkeleton` renders six published `Skeleton` controls with app-owned
layout sizing. Their decorative bars stay hidden from assistive technology;
the labelled busy container describes the loading state. Motion uses the
shared reduced-motion contract.
