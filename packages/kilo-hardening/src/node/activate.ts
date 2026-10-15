/**
 * Side-effect entry for the VS Code extension. First import of the extension's activation module:
 * marks hardening active for UI and command gates and fails fast on an inconsistent build config.
 * Network enforcement in the extension host is bundle-scoped (see ../../esbuild.cjs), not here.
 */
import { config } from "../config"
import { Hardening } from "../index"
import { assertConsistent } from "../policy"

assertConsistent(config)
Hardening.activate()
