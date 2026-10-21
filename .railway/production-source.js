// The repository's declared Railway production source.
//
// This file declares what this repository believes its production target is.
// It is a declaration, not a receipt: nothing here was read from Railway, and a
// plan that uses this declaration still needs a live read to confirm it.
//
// The declaration pins the provider identity of the production target: the
// Railway project and the Railway service. An environment alone is not an
// identity - one environment holds many services - so a declaration that named
// only an environment could not say which service a plan meant, and a plan that
// read only an environment could be planned against any service in it. The
// identity is recorded here as deployment configuration, which is what it is:
// the rule in docs/architecture/diagram-sources.md holds, that a provider
// resource name is deployment configuration and not a domain identifier, and
// this declaration records deployment configuration on purpose so that the live
// read has something concrete to agree with.
//
// The identity here is the identity the repository believes. A live read that
// names another project or another service is refused, so a wrong identity
// here can stop a plan but can never let one through.
//
// The declaration also records the shape of a production deployment: the
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
  // resolved, and the plan refuses it instead of choosing. Every candidate
  // names the project and the service it means.
  targets: [{ project: 'adea', service: 'auth', environment: 'production' }],

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
