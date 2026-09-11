/**
 * Preserve Next/URLSearchParams string semantics. TanStack's default JSON
 * parser would turn ?roomDesigner=0 into a number, changing Adea's flag logic.
 * Unknown fields and repeated keys must survive nuqs updates as well.
 * @param {string} input
 * @returns {Record<string, string | string[]>}
 */
export function parseWorkspaceSearch(input) {
  const params = new URLSearchParams(input)
  const result = Object.create(null)
  for (const key of new Set(params.keys())) {
    // These names must never become ordinary object prototype setters.
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    const values = params.getAll(key)
    result[key] = values.length === 1 ? values[0] : values
  }
  return result
}

/** @param {Record<string, unknown>} input */
export function stringifyWorkspaceSearch(input) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(input)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    const values = Array.isArray(value) ? value : [value]
    for (const entry of values) {
      if (entry === undefined || entry === null) continue
      if (typeof entry !== 'string' && typeof entry !== 'number' && typeof entry !== 'boolean') {
        throw new TypeError(`Unsupported search parameter: ${key}`)
      }
      params.append(key, String(entry))
    }
  }
  const query = params.toString()
  return query ? `?${query}` : ''
}
