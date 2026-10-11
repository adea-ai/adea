# Desktop support surfaces

Keep the desktop account menu, update, About, and Help surfaces consistent with
the shared UI packages. Compose `createAppMenuItems` and the shared
`AccountMenu`, `UpdateDialog`, `AboutDialog`, and `HelpCenter`; do not recreate
their menu rows, dialogs, layout, or interaction behavior in the host app.

Pass the native rounded app mark from
`apps/desktop/shell/icon.iconset/icon_256x256.png?url` to About and Updates.
The web square SVG is not the desktop app icon. Keep host-specific identity,
runtime adapters, callbacks, and external-link routing in the app wrapper.

The native updater's `changelog` is the complete installed `CHANGELOG.md`,
embedded in the shell so installed history is available offline in every update
state. Keep the newest downloaded release body in the separate `release_notes`
field; never replace the installed history with that single-version body. The
web fallback loads the complete changelog asset only when the update dialog
opens, caches successful loads, and can retry failed loads. Keep a regression
test that checks an older version at the tail of the history.

Route Help Center resources, About source links, and feedback links through the
desktop external-link command so they open in the system browser. Keep native
external navigation restricted to the Adea GitHub repository over HTTPS. Use
the shared feedback issue template at
`.github/ISSUE_TEMPLATE/feedback.yml` (`context` field id); prefill only the
app, runtime, version, and platform context. Leave report details optional and
let the person choose what to include.
