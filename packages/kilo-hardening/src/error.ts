import type { Scope } from "./config"

/** Thrown for every blocked outbound attempt. `host` never includes the path or query, so keys in URLs are not echoed. */
export class EgressDeniedError extends Error {
  readonly code = "EGRESS_DENIED"
  constructor(
    readonly host: string,
    readonly scope: Scope,
    readonly via: string,
  ) {
    super(
      `Network access to ${host} is blocked: it is not on this build's ${scope} allowlist. ` +
        `The allowlist is set when the extension is built and cannot be changed on this machine.`,
    )
    this.name = "EgressDeniedError"
  }
}

export function isEgressDenied(err: unknown): err is EgressDeniedError {
  if (err instanceof EgressDeniedError) return true
  // Errors can cross realms (workers, bundles with duplicated modules): fall back to the code.
  return !!err && typeof err === "object" && (err as { code?: unknown }).code === "EGRESS_DENIED"
}

/** Walks `cause` chains (fetch wraps socket errors) to find a denial. */
export function findEgressDenied(err: unknown, depth = 0): EgressDeniedError | undefined {
  if (depth > 8 || !err || typeof err !== "object") return undefined
  if (isEgressDenied(err)) return err as EgressDeniedError
  return findEgressDenied((err as { cause?: unknown }).cause, depth + 1)
}
