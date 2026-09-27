import type { DevErrorCode } from '@adea-ai/types/dev-runtime'

/** User-safe copy keyed by the typed error code; host-provided messages stay internal. */
export function terminalConnectionErrorMessage(code: DevErrorCode): string {
  switch (code) {
    case 'stale_generation':
      return 'The terminal restarted. Queued input from the previous generation was discarded.'
    case 'delivery_ambiguous':
      return 'Input may have reached the terminal and was not retried. Check the terminal before sending it again.'
    case 'permission_denied':
      return 'Terminal access was denied.'
    case 'runtime_node_unavailable':
      return 'The terminal runtime is unavailable.'
    default:
      return 'The terminal connection encountered an error.'
  }
}
