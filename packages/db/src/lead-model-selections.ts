/** Canonical requested choices only; CP owns selection eligibility and accepted runtime pins. */
export type ModelSelectionReference = Readonly<{
  selectionRef: string
  selectionRevision: number
}>
export type RequestedRoleModelSelections = Readonly<{
  lead?: ModelSelectionReference
  child?: ModelSelectionReference
}>

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
/** Mirrors the agreed strict reference-only transport, without claiming an unpublished SDK export. */
export function parseRequestedRoleModelSelections(
  value: unknown
): RequestedRoleModelSelections | undefined {
  if (value === undefined) return undefined
  if (
    !record(value) ||
    Object.keys(value).length === 0 ||
    Object.keys(value).some((key) => key !== 'lead' && key !== 'child')
  )
    throw new Error('Invalid requested model selections')
  const result: { lead?: ModelSelectionReference; child?: ModelSelectionReference } = {}
  for (const role of ['lead', 'child'] as const) {
    if (!Object.hasOwn(value, role)) continue
    const choice = value[role]
    if (
      !record(choice) ||
      Object.keys(choice).toSorted().join(',') !== 'selectionRef,selectionRevision' ||
      typeof choice.selectionRef !== 'string' ||
      !/^msel_[a-f0-9]{32}$/.test(choice.selectionRef) ||
      typeof choice.selectionRevision !== 'number' ||
      !Number.isSafeInteger(choice.selectionRevision) ||
      choice.selectionRevision < 1
    )
      throw new Error('Invalid requested model selections')
    result[role] = Object.freeze({
      selectionRef: choice.selectionRef,
      selectionRevision: choice.selectionRevision,
    })
  }
  return Object.freeze(result)
}

export function sameRequestedRoleModelSelections(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(parseRequestedRoleModelSelections(left)) ===
    JSON.stringify(parseRequestedRoleModelSelections(right))
  )
}
