// The repository's declared Railway production source.
//
// This file declares what this repository believes its production target is.
// It is a declaration, not a receipt: nothing here was read from Railway, and a
// plan that uses this declaration still needs a live read to confirm it.
//
// The declaration is deliberately narrow, because the repository records
// deployment configuration only as far as it can stand behind. Railway project
// and service identifiers are provider configuration, not domain identifiers,
// and this repository does not record them (docs/architecture/diagram-sources.md).
// What the repository does record is the shape of a production deployment: the
// environment production runs in, the metadata every production deployment must
// publish, and any metadata value the repository pins.
//
// A declaration that names no target, names more than one target, contradicts
// the live read or leaves a required metadata field unstated is refused by
// scripts/railway-production-plan.mjs rather than planned around.

const productionSource = {
  // The environment production traffic runs in. A live target in any other
  // environment is a contradiction, not a plan.
  environment: 'production',

  // The candidate production targets. One candidate is a plan; none is a
  // refusal; more than one is an ambiguity that this repository has not
  // resolved, and the plan refuses it instead of choosing.
  targets: [{ environment: 'production' }],

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
