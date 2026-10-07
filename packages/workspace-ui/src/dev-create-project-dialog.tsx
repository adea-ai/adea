/*
 * The Dev sidebar's detailed new-project dialog, hosted by the workspace-ui
 * shells when the mounting host injects a Dev Runtime flow (ADR 0011). The
 * wrapper exists so the dev-view stylesheet rides the same lazy chunk as the
 * dialog: hosts that never mounted a Dev pane still render the form's
 * `dev-tree-*` classes correctly on first open.
 */
import '@adea-ai/app-ui/dev-view.css'

export { DevNewProjectDialog } from '@adea-ai/dev-view/sidebar/dev-nav-dialogs'
