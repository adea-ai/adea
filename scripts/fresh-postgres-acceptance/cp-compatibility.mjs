// The confirmed PostgreSQL compatibility scope of the Control Plane.
//
// The application, the authentication provider and the Control Plane own
// separate migration boundaries. A successful migration of one does not
// initialize the others, and an Adea receipt does not qualify the Control
// Plane's own entry point, journal, object ownership or privileges.
//
// The record below names every item in scope and its owner, and the guard
// refuses to record a Control-Plane-owned item as qualified by an Adea
// receipt. The open items stay open: they are the Control Plane's own
// evidence, in the Control Plane's own repository, and this lane cannot
// produce them.

/** The owners a scope item may have. */
export const CP_SCOPE_OWNERS = Object.freeze(['adea', 'control-plane'])

/** The receipts that may qualify an item. */
export const CP_SCOPE_QUALIFIERS = Object.freeze([
  'adea-receipt',
  'control-plane-receipt',
  'live-receipt',
])

/**
 * The confirmed scope.
 *
 * Every item names the evidence that qualifies it. The Control Plane's items
 * are qualified by a Control Plane receipt, which this repository does not
 * hold; they are listed so the gap is explicit rather than implied.
 */
export const CP_COMPATIBILITY_SCOPE = Object.freeze([
  Object.freeze({
    id: 'adea-application-migrations',
    owner: 'adea',
    qualifiedBy: 'adea-receipt',
    statement:
      'the application migrations apply to an empty owned database and the journal replays against the current checkout',
  }),
  Object.freeze({
    id: 'adea-canonical-privileges',
    owner: 'adea',
    qualifiedBy: 'adea-receipt',
    statement:
      'the canonical migration and runtime roles are separated, and the runtime role is refused object creation',
  }),
  Object.freeze({
    id: 'adea-array-type-registration',
    owner: 'adea',
    qualifiedBy: 'adea-receipt',
    statement:
      'the production array parser is registered once per connection and the declared array column round-trips unchanged',
  }),
  Object.freeze({
    id: 'cp-production-migration-entry-point',
    owner: 'control-plane',
    qualifiedBy: 'control-plane-receipt',
    statement:
      'the Control Plane production migration entry point applies its own migrations to its own empty database',
  }),
  Object.freeze({
    id: 'cp-migration-journal',
    owner: 'control-plane',
    qualifiedBy: 'control-plane-receipt',
    statement: 'the Control Plane journal replays against its own current checkout',
  }),
  Object.freeze({
    id: 'cp-object-ownership',
    owner: 'control-plane',
    qualifiedBy: 'control-plane-receipt',
    statement: 'the Control Plane owns the objects its migrations create',
  }),
  Object.freeze({
    id: 'cp-application-privileges',
    owner: 'control-plane',
    qualifiedBy: 'control-plane-receipt',
    statement:
      'the Control Plane runtime role is separated from its migration role, and its privileges are recorded',
  }),
])

/**
 * Checks a scope record.
 *
 * An item owned by the Control Plane may not be qualified by an Adea receipt,
 * and an item owned by Adea may not be qualified by a Control Plane receipt.
 * A scope that claims the other side's evidence is refused.
 */
export function assertCpScope(scope = CP_COMPATIBILITY_SCOPE) {
  if (!Array.isArray(scope) || scope.length === 0) {
    throw new Error('the compatibility scope is empty')
  }
  for (const item of scope) {
    if (!CP_SCOPE_OWNERS.includes(item?.owner)) {
      throw new Error('unknown compatibility scope owner: ' + String(item?.owner))
    }
    if (!CP_SCOPE_QUALIFIERS.includes(item?.qualifiedBy)) {
      throw new Error('unknown compatibility scope qualifier: ' + String(item?.qualifiedBy))
    }
    const ownerQualifiers = {
      adea: ['adea-receipt', 'live-receipt'],
      'control-plane': ['control-plane-receipt', 'live-receipt'],
    }[item.owner]
    if (!ownerQualifiers.includes(item.qualifiedBy)) {
      throw new Error(
        'compatibility scope item ' +
          item.id +
          ' is qualified by an evidence its owner does not hold'
      )
    }
  }
  return scope
}

/**
 * The items this repository cannot qualify.
 *
 * They are the open dependency of the compatibility scope: each one needs
 * the Control Plane's own receipt, in the Control Plane's own repository.
 */
export function cpOpenItems(scope = CP_COMPATIBILITY_SCOPE) {
  assertCpScope(scope)
  return scope.filter((item) => item.owner === 'control-plane')
}
