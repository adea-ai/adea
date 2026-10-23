/**
 * The types of the repository's declared Railway production source.
 *
 * The declaration lives in `.railway/production-source.js` and is a CommonJS
 * module, because the repository's root package declares no module type. The
 * plan in `scripts/railway-production-plan.mjs` reads it and refuses a
 * declaration that does not have this shape.
 */

/**
 * One candidate production target.
 *
 * The identity is required: a target that names no project and no service does
 * not say which deployment a plan meant. A pinned field must match the live read.
 */
export interface ProductionTargetDeclaration {
  /** The Railway project identifier the target lives in. */
  project: string
  /** The Railway service identifier the target is. */
  service: string
  /** The environment the target runs in, when the repository records one. */
  environment?: string
}

/** The repository's declaration of its production source. */
export interface ProductionSourceDeclaration {
  /**
   * Whether this repository has configured a production identity.
   *
   * It has not. While this is false the declaration names no target and the
   * plan refuses without making a live read, because there is no declared
   * target for a read to agree with.
   */
  configured: boolean
  /** The environment production traffic runs in. */
  environment: string
  /** The candidate production targets. One is a plan; more than one is ambiguous. */
  targets: ProductionTargetDeclaration[]
  /** The deployment metadata every production deployment must publish. */
  requiredMetadata: string[]
  /** The metadata values the repository pins, by field. */
  pinnedMetadata: Record<string, string>
}

/** The declaration this repository ships. */
export declare const productionSource: ProductionSourceDeclaration
