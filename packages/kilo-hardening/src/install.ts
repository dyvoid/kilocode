/**
 * Side-effect entry for CLI processes and their worker isolates. Must be the first import of the
 * entry module: flag modules read process.env when they load, and code that captures `fetch` before
 * the guard is installed would bypass it.
 */
import { config } from "./config"
import { apply, cliEnv, PROXY_APP } from "./env"
import { install } from "./guard"
import { Hardening } from "./index"
import { assertConsistent } from "./policy"

assertConsistent(config)
apply(process.env, cliEnv(config))
Hardening.activate()
install({ scope: "app", proxy: process.env[PROXY_APP] || undefined })
