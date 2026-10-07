/*
 * The designed display label for each browser lane kind. The wire kind is an
 * implementation identifier and never reaches a surface as raw text — the
 * lanes list and the floating mini preview project it through this map.
 */
import type { BrowserLane } from '@adea-ai/types/dev-runtime'

export const LANE_KIND_LABEL: Record<BrowserLane['kind'], string> = {
  human_embedded: 'Human · embedded',
  task_owned: 'Task-owned agent',
  user_context: 'User context · external',
}
