/**
 * Side-effect entry for CLI processes and their worker isolates. Must be the first import of the
 * entry module: flag modules read process.env when they load, and code that captures `fetch` before
 * the guard is installed would bypass it.
 */
import { config } from "./config"
import { apply, cliEnv, cliProxy, strayProxies } from "./env"
import { install } from "./guard"
import { Hardening } from "./index"
import { assertConsistent } from "./policy"

assertConsistent(config)
// Stray proxy variables are removed for child processes; Bun's own fetch has already read them (see wrapFetch).
const stray = strayProxies(process.env, config)
apply(process.env, { ...cliEnv(config), ...Object.fromEntries(stray.map((item) => [item.name, undefined])) })
Hardening.activate()
install({ scope: "cli", proxy: cliProxy(process.env), stray: stray.at(0)?.url })
