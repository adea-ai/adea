# @adea-ai/workspace-ui

Workspace presentation layer: conventional (chat) workspace shell, roster,
conversation surface, task board, marketplace and plugin dialogs, global rail,
settings, and the loader and `VirtualUnavailable` fallback for the optional
private engine. Consumes `@adea-ai/data` and `@adea-ai/state`; never
imports engine packages directly.

The loader uses the public `@adea-ai/spatial` manifest contract. A same-origin
engine module must register `window.__adeaAgentSim.mount({ container, engine })`
and return a promise containing `unmount()`. The loader checks the callable
entry point, not engine version compatibility or payload hashes. Source-level
API agreement does not certify a distributed engine pack.

Private message bodies and task objectives use the host's private-content
resolver. Resolved plaintext is shown only while its resolver, workspace, and
content reference still match. Switching items hides old plaintext immediately,
and later responses or failures from the previous request are ignored.

Navigation projection and selection live in `workspace-model`; Chat mention parsing
and command-search matching live in `workspace-text-match`. Their separate module
boundaries keep text helpers out of Virtual navigation's eager chunk graph.

## Conversation presentation

The workspace keeps channel and thread queries, participant and artifact lookup,
read markers, drafts, private-content authorization, and message submission in its
app adapter. It composes the published `ConversationSurface`, `MessageRow`,
`MessageBody`, `AttachmentCard`, and `ThreadPanel` for transcript presentation.
Reading position is cached by channel as both a scroll offset and follow intent;
the shared scroller owns follow behavior while the workspace owns that identity
and restoration snapshot.

The global app container retains its rail in every view. Contextual sidebars use
one shared layout with view-owned content: Dev, Chat, and Virtual provide their
usual navigation and utility content, while Room and Character design hide both
sidebars and their toolbar toggles. New app views can replace the content without
rebuilding the rail, toolbar, resizing, or collapse behavior.

## Global rail

The `GlobalWorkspaceRail` stays mounted across workspace views. Ctrl/Cmd+K
calls its host-owned `onOpenSearch` action, so the host can open Chat search or
focus the App Library search when Chat is disabled. Workspace selection uses
the published dropdown radio menu: arrow keys move between workspaces, Enter
selects one, and Escape closes the menu and restores focus to its trigger.

Workspace search composes the published `Command` primitives for combobox and
listbox semantics, active-result selection, keyboard navigation, and focus
management. Built-in command filtering stays disabled so local fuzzy ranking,
authorized private results, and remote result ordering remain host-owned.

The published shared UI `SideRail` family owns the rail's header, scrolling
navigation, footer, active states, focus treatment, and destination tooltips.
Adea supplies ordered/enabled destinations, shortcut dispatch, workspace
selection, and prefetch callbacks. Host CSS supplies positioning, safe-area
insets, and menu width; it does not redefine the component's icon or active
styling. The account adapter maps platform-specific commands into the shared
`AccountMenu` instead of composing a second menu.

The account menu opens Updates after its menu focus cycle closes. It supplies
the persistent rail button through the host adapter to the published dialog
so closing Updates restores focus without retaining a removed menu item.

## Plugin marketplace

`PluginsDialog` composes the published
`@adea-ai/ui/components/composites/catalog-browser` for Discover, Installed,
search, category expansion, result details, and return focus. The workspace
provider remains authoritative for the verified catalog, install requests,
recovery state, permissions, and bundled app activation. Its Navigation tab is
a host-rendered supplemental view; this plugin marketplace remains separate
from the #757 App Library's core-view and rail-management flow.

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

Task and creation forms retain domain validation, labels, submission, and layout.
Published `Label`, `Input`, and `Textarea` own their typography, borders, padding,
shape, and focus treatment; host selectors must not replace those appearances.
The task drawer closes through the shared `ActionButton` composition, preserving
drawer dismissal and focus restoration while adding the standard tooltip.

## Settings navigation

Settings composes the published grouped `SettingsNavigation` inside controlled
vertical Tabs. The shared component owns row styling, roving focus, Up/Down,
Home/End, and revealing the selected row within scrollable ancestors. Adea owns
section values, icons, hash synchronization, panel content, and reselection.
Narrow layouts arrange the groups horizontally with scrolling; their tab
sequence and vertical keyboard semantics remain the same.

Microphone permission checks catch host failures and show a retryable message in
Settings. The check button prevents concurrent requests, and a result from a
closed or unmounted dialog cannot change its permission presentation.

Plugins detail fields use published `CatalogDetail sectionsLayout="columns"`: one padded outlined card, responsive stacking, and shared column dividers. The app supplies its capabilities, connection, bundle, and activation data without overriding shared section padding or borders.

An install refusal stays attached to its plugin and remains visible after returning to the catalog. Closing Plugins clears that attempt; late responses from a closed dialog or replaced provider cannot overwrite the reopened dialog.

Icon actions retain their shared ActionButton tooltips in both the inline sidebar and mobile modal navigation. The shared tooltip dismissal contract lets one Escape close navigation and restore the contextual-toggle focus, including after keyboard focus reveals a row action’s explanation.

The navigation container leaves its outer edge unclipped so the shared pixel
resize handle receives pointer input along its full height. Content scrolling
and clipping belong to the inner sidebar content. Width changes persist after
pointer release and reload, alongside the keyboard resize path.

Workspace containers do not reset descendant controls’ typography, focus outlines, disabled appearance, or SVG dimensions. Those contracts come from the published primitives and their size/variant props, consistently in the inline and virtual sidebars and the rest of the workspace.

## Settings provider failures

The local/private content health check treats synchronous host bridge failures
and asynchronous provider refusals as unavailable. A late result from a closed
dialog cannot change the reopened dialog's health state.

## Agent profile remediation

The roster preserves exact profile/version IDs while showing specific remediation
for missing, deprecated, revoked, unapproved or incompatible pins. A failed
availability check has its own unknown state and keeps the selected version.
Catalog availability does not imply runtime health or execution activity.

## Execution host inventory

Workspace details › Connections lazily loads a read-only execution-host
inspector. Registration/proof, reported Control Plane node health, individual
connection health, freshness, grants, entitlement, compatibility and capabilities
stay separate. Observations age without network polling; refresh and committed
node events reconcile them. Inspecting a host changes no execution selection or
history authority. Scope changes/close cancel unused queries and discard pages;
failed refreshes do not retain a previous eligible presentation.
