# @adea-ai/workspace-ui

Workspace presentation layer: conventional (chat) workspace shell, roster,
conversation surface, task board, marketplace and plugin dialogs, global rail,
settings, and the `VirtualUnavailable` fallback rendered wherever the private
engine view mounts. Consumes `@adea-ai/data` and `@adea-ai/state`; never
imports engine packages directly.

Workspace dialogs import `ModalDialog` directly from the published
`@adea-ai/ui` package. Product hooks provide layout and workspace-specific
content; the shared component owns the overlay, header, close action, and
background containment. These controlled dialogs keep `modal={false}` for
their existing Kobalte interaction mode while the shared modal manages inert
background elements and restores their previous state on close or unmount.
