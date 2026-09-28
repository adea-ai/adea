# @adea-ai/workspace-ui

Workspace presentation layer: conventional (chat) workspace shell, roster,
conversation surface, task board, marketplace and plugin dialogs, global rail,
settings, and the `VirtualUnavailable` fallback rendered wherever the private
engine view mounts. Consumes `@adea-ai/data` and `@adea-ai/state`; never
imports engine packages directly.

Private message bodies and task objectives use the host's private-content
resolver. Resolved plaintext is shown only while its resolver, workspace, and
content reference still match. Switching items hides old plaintext immediately,
and later responses or failures from the previous request are ignored.

## Global rail

The `GlobalWorkspaceRail` stays mounted across workspace views. Ctrl/Cmd+K
calls its host-owned `onOpenSearch` action, so the host can open Chat search or
focus the App Library search when Chat is disabled. Workspace selection uses
the published dropdown radio menu: arrow keys move between workspaces, Enter
selects one, and Escape closes the menu and restores focus to its trigger.

The account menu opens Updates after its menu focus cycle closes. It supplies
the persistent rail button through the host adapter to the published dialog
so closing Updates restores focus without retaining a removed menu item.

## Loading state

`WorkspaceSkeleton` renders six published `Skeleton` controls with app-owned
layout sizing. Their decorative bars stay hidden from assistive technology;
the labelled busy container describes the loading state. Motion uses the
shared reduced-motion contract.

Workspace dialogs import `ModalDialog` directly from the published
`@adea-ai/ui` package. Product hooks provide layout and workspace-specific
content; the shared component owns the overlay, header, close action, and
background containment. These controlled dialogs keep `modal={false}` for
their existing Kobalte interaction mode while the shared modal manages inert
background elements and restores their previous state on close or unmount.
