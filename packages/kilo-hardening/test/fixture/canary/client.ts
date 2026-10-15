// Canary fixture: one URL literal and one bare hostname a reviewer has not seen.
export const endpoint = "https://new-telemetry.example.net/v1/collect"
export const host = "beacon.example.io"
export const templated = (account: string) => `https://${account}.warehouse.example.com/api`
export const escaped = "https:\/\/escaped.example.org\/x"
export const withCreds = "https://user:pw@creds.example.net/"
export const bareWithPort = "bare.example.dev:8443"
export const regional = (region: string) => `https://svc.${region}.later.example.com/x?u=a@b.example`
export const property = (cfg: { host: string }) => `https://${cfg.host}.prop.example.com/x`
export const trailing = (path: string) => `https://trail.example.com${path}`
export const env = () => `https://${process.env.X}.env.example.net/v1`
