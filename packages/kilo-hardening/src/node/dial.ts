import net from "node:net"
import type { Scope } from "../config"
import { permit } from "../policy"

/**
 * For callers that resolve a name themselves and dial the address (the browser automation proxy):
 * checks the name against the scope, then connects to the given options with the unshimmed module.
 */
export function connectAs(scope: Scope, host: string, port: number, options: net.NetConnectOpts) {
  permit(scope, host, port, "connect")
  return net.connect(options)
}
