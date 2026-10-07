/*
 * Copyright (c) 2026 Adea contributors.
 *
 * Session-persistent show-more state for the resources sheet's section lists
 * (owner follow-up: the ports/server sections collapse to the first 8 rows
 * with a Show more control). Module scope on purpose: it survives tab switches
 * and drill-in views inside one session and resets when the sheet remounts.
 */
import { createSignal } from 'solid-js'

const [expandedSections, setExpandedSections] = createSignal<ReadonlySet<string>>(new Set())

export function sectionExpanded(id: string): boolean {
  return expandedSections().has(id)
}

export function toggleSection(id: string, expanded: boolean): void {
  setExpandedSections((current) => {
    const next = new Set(current)
    if (expanded) next.add(id)
    else next.delete(id)
    return next
  })
}
