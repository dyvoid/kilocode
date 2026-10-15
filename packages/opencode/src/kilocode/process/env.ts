export function model(extra?: NodeJS.ProcessEnv | null): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries({ ...process.env, ...(extra ?? {}) }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  )
  delete env.KILO_SERVER_PASSWORD
  delete env.KILO_SERVER_USERNAME
  delete env.KILO_BROWSER_BROKER_URL
  delete env.KILO_BROWSER_BROKER_TOKEN
  delete env.KILO_CONFIG
  delete env.KILO_CONFIG_CONTENT
  delete env.KILO_CONFIG_DIR
  // Restricted-egress build: the CLI's own proxy port allows app hosts; model-run commands get only the tools proxy.
  delete env.KILO_HARDENING_CLI_PROXY
  return env
}
