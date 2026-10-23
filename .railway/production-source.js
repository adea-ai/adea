// The repository's declared Railway production source.
//
// This file declares what this repository believes its production target is.
// It is a declaration, not a receipt: nothing here was read from Railway, and a
// plan that uses this declaration still needs a live read to confirm it.
//
// The production identity is NOT configured in this repository, and this
// declaration says so rather than guessing one. A Railway project and service
// are provider configuration rather than domain identifiers, and this
// repository does not record them (docs/architecture/diagram-sources.md). It
// does not establish that a Railway deployment exists either:
// docs/guides/railway-cost-week-plan.md records that whether a Railway
// deployment of the auth service exists is not established, and
// docs/guides/railway-cutover-checklist.md records that this repository holds
// no live deployment inventory. A declaration naming an identity the
// repository cannot stand behind would be a claim, and a plan that agreed with
// a claim would be worth nothing.
//
// So the declaration is explicitly unconfigured: `configured` is false, no
// target is named, and the plan refuses with
// RAILWAY_PRODUCTION_SOURCE_UNCONFIGURED without making a live read at all -
// there is no declared target for a read to agree with. Nothing can be planned
// until an owner who can see the Railway console records the identity.
//
// The machinery that checks that identity once it is recorded is already in
// place and is exercised by the offline suite: a concrete project and service,
// a live target that matches them, and a deployment history bound to that same
// target.
//
// What the repository does record is the shape of a production deployment: the
// environment production runs in, the metadata every production deployment must
// publish, and any metadata value the repository pins.
//
// A declaration that names no target, names more than one target, contradicts
// the live read or leaves a required metadata field unstated is refused by
// scripts/railway-production-plan.mjs rather than planned around.

const productionSource = {
  // Whether this repository has configured a production identity. It has not.
  // While this is false the plan refuses and makes no live read.
  configured: false,

  // The environment production traffic runs in. A live target in any other
  // environment is a contradiction, not a plan.
  environment: 'production',

  // The candidate production targets. None is configured, so none is named
  // here. One candidate is a plan; none is a refusal; more than one is an
  // ambiguity that this repository has not resolved, and the plan refuses it
  // instead of choosing. Every candidate names the project and the service it
  // means.
  targets: [],

  // The deployment metadata every production deployment must publish. A
  // deployment that leaves one of these unstated is refused: a plan that names
  // a release it cannot see is not a plan.
  requiredMetadata: ['release', 'imageDigest', 'region', 'promotedAt'],

  // The metadata values this repository pins, by field. Nothing is pinned
  // here yet: the release, the image digest, the region and the promotion time
  // are recorded in the receipts of the change that produced them, not in the
  // source tree. A pinned value that the live read contradicts is a refusal.
  pinnedMetadata: {},
}

module.exports = { productionSource }
