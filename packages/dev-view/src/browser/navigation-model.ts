import type { BrowserLane } from '@adea-ai/types/dev-runtime'

import { isPreviewableRow, type PreviewableServer } from './ports-model'

export type BrowserNavigationLane = Pick<BrowserLane, 'id' | 'generation'>

export type BrowserNavigationRequest = Readonly<{
  operation: 'dev.browser.navigate'
  lane: BrowserNavigationLane
  body: Readonly<{
    browserLaneId: string
    expectedGeneration: number
    url: string
  }>
  resource: Readonly<{
    kind: 'browser_lane'
    id: string
    generation: number
  }>
}>

export function buildBrowserNavigationRequest(
  url: string,
  lane: BrowserNavigationLane | undefined
): BrowserNavigationRequest | null {
  const requestedUrl = url.trim()
  if (!requestedUrl || !lane) return null

  return {
    operation: 'dev.browser.navigate',
    lane,
    body: {
      browserLaneId: lane.id,
      expectedGeneration: lane.generation,
      url: requestedUrl,
    },
    resource: { kind: 'browser_lane', id: lane.id, generation: lane.generation },
  }
}

export function buildPortNavigationRequest(
  row: PreviewableServer,
  lanes: readonly BrowserNavigationLane[],
  activeLane: BrowserNavigationLane | undefined
): BrowserNavigationRequest | null {
  if (!isPreviewableRow(row)) return null

  const lane = row.preview
    ? lanes.find((candidate) => candidate.id === row.preview?.browserLaneId)
    : activeLane
  return buildBrowserNavigationRequest(row.requestedUrl, lane)
}
