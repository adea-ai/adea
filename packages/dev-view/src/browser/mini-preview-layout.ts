/*
 * Copyright (c) 2026 T3 Tools Inc.
 * Licensed under the MIT License.
 *
 * Floating mini-preview geometry, substantially transcribed from t3code
 * apps/web/src/components/preview/previewMiniPlayerLayout.ts and its test
 * file (MIT), revision 77bca8b2d76a1f42552e5eee7d277fcb1160347a. Donor
 * viewport/device type seams were replaced with Adea's Dev Runtime types;
 * the formulas, constants, and edge-case behavior are preserved. See NOTICE
 * and docs/research/dev-view-donor-audit.md.
 */

export const PREVIEW_MINI_PLAYER_EDGE_GAP = 12
export const PREVIEW_MINI_PLAYER_CORNER_RADIUS = 12
/** Within the app: dialogs begin above this; the shell's own chrome sits below. */
export const PREVIEW_MINI_PLAYER_CONTENT_Z_INDEX = 48

export interface PreviewMiniPlayerSize {
  readonly width: number
  readonly height: number
}
export interface PreviewMiniPlayerPosition {
  readonly x: number
  readonly y: number
}
export interface PreviewMiniPlayerFrame extends PreviewMiniPlayerPosition, PreviewMiniPlayerSize {}

export type BrowserViewportResizeDirection =
  | 'north'
  | 'south'
  | 'east'
  | 'west'
  | 'northwest'
  | 'northeast'
  | 'southwest'
  | 'southeast'

export type DeviceScreenOrientation = 'portrait' | 'landscape_left' | 'landscape_right'
export interface DeviceScreenSize {
  readonly width: number
  readonly height: number
  readonly orientation: DeviceScreenOrientation
}
export type DevicePlatform = 'ios' | 'android'

// A fresh player is the largest box at the source aspect ratio that fits here.
const PREVIEW_MINI_PLAYER_DEFAULT_BOX = { width: 320, height: 320 } as const
const PREVIEW_MINI_PLAYER_MIN_SIZE = { width: 240, height: 150 } as const

/**
 * The device screen as the user sees it, so a rotated phone floats as a
 * landscape box. Before the stream reports its size the platform's usual
 * phone shape stands in.
 */
export function resolveDeviceMiniPlayerSourceSize(
  platform: DevicePlatform,
  screen: DeviceScreenSize | null
): PreviewMiniPlayerSize {
  if (!screen) {
    const width = 1_000
    return { width, height: width / (platform === 'ios' ? 9 / 19.5 : 9 / 20) }
  }
  const landscape =
    screen.orientation === 'landscape_left' || screen.orientation === 'landscape_right'
  const long = Math.max(screen.width, screen.height)
  const short = Math.min(screen.width, screen.height)
  return landscape ? { width: long, height: short } : { width: short, height: long }
}

/**
 * The Android emulator composites the skin's rounded corners into its
 * framebuffer as black wedges (measured at ~13% of the short side on a
 * Pixel 9), so its player clips at a matching phone-like radius; iOS
 * simulators stream an edge-to-edge rectangle and keep the frame radius.
 */
export function resolveDeviceMiniPlayerCornerRadius(
  platform: DevicePlatform,
  player: PreviewMiniPlayerSize
): number {
  if (platform !== 'android') return PREVIEW_MINI_PLAYER_CORNER_RADIUS
  return Math.max(
    PREVIEW_MINI_PLAYER_CORNER_RADIUS,
    Math.round(Math.min(player.width, player.height) * 0.14)
  )
}

interface HorizontalSpan {
  readonly left: number
  readonly right: number
}

/**
 * The composer stack docked to the bottom edge, in container coordinates. It
 * only reserves the columns it covers, so the margins beside it stay open all
 * the way down.
 */
export interface PreviewMiniPlayerObstacles {
  readonly composer: (HorizontalSpan & { readonly height: number }) | null
}

export const NO_PREVIEW_MINI_PLAYER_OBSTACLES: PreviewMiniPlayerObstacles = { composer: null }

const spanOf = (x: number, width: number): HorizontalSpan => ({ left: x, right: x + width })

const spansOverlap = (a: HorizontalSpan, b: HorizontalSpan) => a.left < b.right && a.right > b.left

/** The lowest row (before the edge gap) open to a player covering these columns. */
function floorFor(
  span: HorizontalSpan,
  container: PreviewMiniPlayerSize,
  obstacles: PreviewMiniPlayerObstacles
): number {
  const { composer } = obstacles
  return composer && spansOverlap(span, composer)
    ? container.height - Math.max(0, composer.height)
    : container.height
}

/**
 * The box a stored size is fitted into. A player with a position keeps the
 * rows its own columns have, so a tall frame parked beside the composer
 * survives the next layout pass; without one it takes the rows above the
 * composer, which every column has.
 */
const availableArea = (
  container: PreviewMiniPlayerSize,
  obstacles: PreviewMiniPlayerObstacles,
  span: HorizontalSpan | null
): PreviewMiniPlayerSize => ({
  width: container.width - PREVIEW_MINI_PLAYER_EDGE_GAP * 2,
  height:
    (span
      ? floorFor(span, container, obstacles)
      : container.height - Math.max(0, obstacles.composer?.height ?? 0)) -
    PREVIEW_MINI_PLAYER_EDGE_GAP * 2,
})

/**
 * Width is the player's only free dimension; height always follows the source
 * aspect ratio so the content fills the box without letterboxing. The player
 * never grows past the source's own size, and a tight container wins over the
 * minimum.
 */
function fitPreviewMiniPlayerWidth(
  desiredWidth: number,
  source: PreviewMiniPlayerSize,
  max: PreviewMiniPlayerSize
): PreviewMiniPlayerSize {
  const aspectRatio = source.width / source.height
  const width = Math.min(
    Math.max(
      desiredWidth,
      PREVIEW_MINI_PLAYER_MIN_SIZE.width,
      PREVIEW_MINI_PLAYER_MIN_SIZE.height * aspectRatio
    ),
    source.width,
    Math.max(1, max.width),
    Math.max(1, max.height * aspectRatio)
  )
  return { width: Math.round(width), height: Math.round(width / aspectRatio) }
}

function defaultPreviewMiniPlayerWidth(source: PreviewMiniPlayerSize): number {
  return Math.min(
    PREVIEW_MINI_PLAYER_DEFAULT_BOX.width,
    (PREVIEW_MINI_PLAYER_DEFAULT_BOX.height * source.width) / source.height
  )
}

const clampToContainer = (
  position: PreviewMiniPlayerPosition,
  container: PreviewMiniPlayerSize,
  player: PreviewMiniPlayerSize,
  bottom = container.height
): PreviewMiniPlayerPosition => ({
  x: Math.min(
    Math.max(position.x, PREVIEW_MINI_PLAYER_EDGE_GAP),
    Math.max(
      PREVIEW_MINI_PLAYER_EDGE_GAP,
      container.width - player.width - PREVIEW_MINI_PLAYER_EDGE_GAP
    )
  ),
  y: Math.min(
    Math.max(position.y, PREVIEW_MINI_PLAYER_EDGE_GAP),
    Math.max(PREVIEW_MINI_PLAYER_EDGE_GAP, bottom - player.height - PREVIEW_MINI_PLAYER_EDGE_GAP)
  ),
})

const overlapsObstacle = (
  position: PreviewMiniPlayerPosition,
  player: PreviewMiniPlayerSize,
  container: PreviewMiniPlayerSize,
  obstacles: PreviewMiniPlayerObstacles
): boolean =>
  position.y + player.height > floorFor(spanOf(position.x, player.width), container, obstacles)

/**
 * Keeps the player inside the container and off the composer. An overlapping
 * player is pushed out along whichever side needs the smaller move, so a drag
 * slides along the composer into the margin beside it instead of stopping at
 * its top edge; when no side leaves it fully clear it sits above the composer.
 */
export function clampPreviewMiniPlayerPosition(
  position: PreviewMiniPlayerPosition,
  container: PreviewMiniPlayerSize,
  player: PreviewMiniPlayerSize,
  obstacles: PreviewMiniPlayerObstacles = NO_PREVIEW_MINI_PLAYER_OBSTACLES
): PreviewMiniPlayerPosition {
  const inside = clampToContainer(position, container, player)
  const { composer } = obstacles
  if (!composer || !overlapsObstacle(inside, player, container, obstacles)) return inside
  const gap = PREVIEW_MINI_PLAYER_EDGE_GAP
  const above = { x: inside.x, y: container.height - composer.height - gap - player.height }
  const beside = [
    { x: composer.left - gap - player.width, y: inside.y },
    { x: composer.right + gap, y: inside.y },
  ]
  let best = clampToContainer(above, container, player)
  let bestDistance = Math.abs(best.y - inside.y)
  for (const candidate of beside) {
    const clamped = clampToContainer(candidate, container, player)
    if (clamped.x !== candidate.x || overlapsObstacle(candidate, player, container, obstacles)) {
      continue
    }
    const distance = Math.abs(candidate.x - inside.x)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

/**
 * Resolves the on-screen frame from the stored width and position. Clamping
 * happens here on every layout pass instead of being written back to the
 * store, so a temporarily narrow container never destroys the user's chosen
 * width. A player without a position sits in the top-right corner.
 */
export function resolvePreviewMiniPlayerFrame(input: {
  readonly width: number | null
  readonly position: PreviewMiniPlayerPosition | null
  readonly source: PreviewMiniPlayerSize
  readonly container: PreviewMiniPlayerSize
  readonly obstacles?: PreviewMiniPlayerObstacles
}): PreviewMiniPlayerFrame {
  const { width, position, source, container, obstacles = NO_PREVIEW_MINI_PLAYER_OBSTACLES } = input
  const size = fitPreviewMiniPlayerWidth(
    width ?? defaultPreviewMiniPlayerWidth(source),
    source,
    availableArea(container, obstacles, position && width ? spanOf(position.x, width) : null)
  )
  const anchored = position ?? {
    x: container.width - PREVIEW_MINI_PLAYER_EDGE_GAP - size.width,
    y: PREVIEW_MINI_PLAYER_EDGE_GAP,
  }
  return { ...clampPreviewMiniPlayerPosition(anchored, container, size, obstacles), ...size }
}

/**
 * Resizes from any edge or corner while holding the aspect ratio. The edge
 * opposite the dragged one stays anchored, so growth stops at the container
 * on that axis and the pointer keeps tracking the grabbed edge.
 */
export function resizePreviewMiniPlayer(input: {
  readonly start: PreviewMiniPlayerFrame
  readonly direction: BrowserViewportResizeDirection
  readonly delta: PreviewMiniPlayerPosition
  readonly source: PreviewMiniPlayerSize
  readonly container: PreviewMiniPlayerSize
  readonly obstacles?: PreviewMiniPlayerObstacles
}): PreviewMiniPlayerFrame {
  const {
    start,
    direction,
    delta,
    source,
    container,
    obstacles = NO_PREVIEW_MINI_PLAYER_OBSTACLES,
  } = input
  const east = direction.includes('east')
  const west = direction.includes('west')
  const north = direction.includes('north')
  const south = direction.includes('south')
  const right = start.x + start.width
  const bottom = start.y + start.height
  const floor = floorFor(spanOf(start.x, start.width), container, obstacles)
  const max = {
    width: west
      ? right - PREVIEW_MINI_PLAYER_EDGE_GAP
      : east
        ? container.width - PREVIEW_MINI_PLAYER_EDGE_GAP - start.x
        : container.width - PREVIEW_MINI_PLAYER_EDGE_GAP * 2,
    height: north
      ? bottom - PREVIEW_MINI_PLAYER_EDGE_GAP
      : south
        ? floor - PREVIEW_MINI_PLAYER_EDGE_GAP - start.y
        : floor - PREVIEW_MINI_PLAYER_EDGE_GAP * 2,
  }
  const desiredWidth = start.width + (east ? delta.x : west ? -delta.x : 0)
  const desiredHeight = start.height + (south ? delta.y : north ? -delta.y : 0)
  const horizontal = east || west
  const vertical = north || south
  const widthLeads =
    horizontal && !vertical
      ? true
      : vertical && !horizontal
        ? false
        : Math.abs(desiredWidth - start.width) / start.width >=
          Math.abs(desiredHeight - start.height) / start.height
  const size = fitPreviewMiniPlayerWidth(
    widthLeads ? desiredWidth : (desiredHeight * source.width) / source.height,
    source,
    max
  )
  const position = clampPreviewMiniPlayerPosition(
    { x: west ? right - size.width : start.x, y: north ? bottom - size.height : start.y },
    container,
    size,
    obstacles
  )
  return { ...position, ...size }
}
