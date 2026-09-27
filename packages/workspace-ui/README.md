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
