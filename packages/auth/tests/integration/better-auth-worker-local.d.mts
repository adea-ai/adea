// Type declarations for the local built-Worker acceptance harness.
//
// The harness is a plain module script, so its public surface is declared here for the
// TypeScript test that exercises the transport-loss policy against it. The declared
// surface is the transport-loss classification, the retry policy it drives, and the
// sanitized inconclusive outcome.

/** The status and body of one response, as the harness reads them. */
export type TransportLossResponse = {
  status: number
  text: string
}

/** The outcome of one attempt: a response, or an explicit inconclusive result. */
export type TransportOutcome =
  | { response: TransportLossResponse; attempts: number; inconclusive?: undefined }
  | { inconclusive: true; operation: string; attempts: number; response?: undefined }

/**
 * A lost connection leaves the outcome of a request unknown. It is raised before any
 * application assertion can read it.
 */
export declare class TransportInconclusiveError extends Error {
  readonly name: 'TransportInconclusiveError'
  readonly operation: string
  readonly attempts: number
  constructor(operation: string, attempts: number)
}

/**
 * Is this response the local ProxyWorker reporting that its own hop to the Worker was
 * lost? Only the captured envelope qualifies.
 */
export declare function isTransportLoss(response: TransportLossResponse | null | undefined): boolean

/**
 * Runs the attempts of one request under an explicit retry policy. `retry` is 'safe'
 * only for an operation whose effect a lost response cannot hide.
 */
export declare function sendUnderPolicy(
  send: () => Promise<TransportLossResponse>,
  options?: {
    operation?: string
    retry?: 'safe' | 'unsafe'
    attempts?: number
  }
): Promise<TransportOutcome>

/**
 * The response of an attempt, when the attempt produced one. A transport-inconclusive
 * attempt throws instead.
 */
export declare function applicationResponse(outcome: TransportOutcome): TransportLossResponse
