/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0.
 *
 * Adapted from KiroCrew routeHistoryPosition.ts at
 * 283e136c0f902e965a535a7c9548c57c7504fed0. Uses TanStack's entry index,
 * instance-local Solid ownership, and the host router's blocker-aware history.
 */
export type WorkspaceHistoryPosition = Readonly<{
  maximum: number | undefined
  canGoBack: boolean
  canGoForward: boolean
}>

export function workspaceHistoryPosition(
  maximum: number | undefined,
  action: string,
  index: unknown
): WorkspaceHistoryPosition {
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
    return { maximum: undefined, canGoBack: false, canGoForward: false }
  }
  const nextMaximum = action === 'PUSH' ? index : Math.max(maximum ?? index, index)
  return { maximum: nextMaximum, canGoBack: index > 0, canGoForward: index < nextMaximum }
}
