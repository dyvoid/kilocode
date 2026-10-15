import { config } from "./config"

export { config, entries, parse, SEARCH_HOSTS, type Config, type Scope, type Search } from "./config"
export { EgressDeniedError, findEgressDenied, isEgressDenied } from "./error"
export { denials, file as logFile, record, type Denial } from "./log"
export { check, describe, entry, loopback, normalize, type Entry } from "./match"
export { SCOPE as FETCH_SCOPE } from "./fetch"
export { cliProxy } from "./env"
export { assertConsistent, permit, permitAsync, permitUrl, permitUrlAsync, sandboxNotes, validateEndpoint } from "./policy"
export { audit, redact } from "./search"

const key = Symbol.for("kilo.hardening.active")
type Holder = { [key]?: boolean }

export namespace Hardening {
  /**
   * True once a process entry point (CLI main, CLI workers, extension activation) has installed
   * hardening. Library code and upstream tests run with it off, so upstream suites keep passing.
   */
  export function active() {
    return (globalThis as Holder)[key] === true
  }

  export function activate() {
    ;(globalThis as Holder)[key] = true
  }

  /** Feature switch for things this build hides but keeps (autocomplete, speech-to-text, ...). */
  export function feature(name: keyof typeof config.features) {
    if (!active()) return true
    return config.features[name]
  }

  /**
   * Directory name for config, data, cache and state ("kilo" upstream). The restricted build uses its own
   * name so it never shares auth, sessions or settings with an upstream Kilo install on the same machine.
   */
  export function app() {
    return active() ? config.identity.name : "kilo"
  }

  /** True when a cloud or account surface must stay off. Shorthand used by the gates in upstream files. */
  export function off() {
    return active()
  }
}
