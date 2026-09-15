'use client'

/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0.
 *
 * Substantially translated from KiroCrew website/src/pages/ChatSidebar.tsx at
 * revision 283e136c0f902e965a535a7c9548c57c7504fed0. Modified for Solid and
 * the dependency-owned archive authority.
 */
import { Archive } from 'lucide-solid'

export function ArchiveShelf() {
  return (
    <button type="button" class="dev-tree-row dev-tree-row--archive" disabled>
      <Archive aria-hidden="true" /> Archived sessions
    </button>
  )
}
