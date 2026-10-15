// Bundled with esbuild.cjs (plugin + inject) and run under Node, as the VS Code extension is.
// Uses the bare module names a bundled dependency would use.
import http from "http"
import https from "node:https"
import net from "net"
import { connect as tlsConnect } from "node:tls"
import WS from "ws"

const blocked = "blocked.invalid"
const out: Record<string, string> = {}

async function probe(name: string, run: () => unknown) {
  try {
    await run()
    out[name] = "ok"
  } catch (err) {
    out[name] = (err as { code?: string }).code === "EGRESS_DENIED" ? "denied" : `error: ${(err as Error).message}`
  }
}

const server = http.createServer((_, res) => res.end("ok"))
await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()))
const port = (server.address() as net.AddressInfo).port

await probe("fetch loopback", async () => (await fetch(`http://127.0.0.1:${port}/`)).text())
await probe("fetch blocked", () => fetch(`https://${blocked}/`))
await probe("WebSocket", () => new WebSocket(`wss://${blocked}/`))
await probe("ws package", () => new WS(`wss://${blocked}/`))
await probe("net.connect", () => net.connect(443, blocked))
await probe("net.Socket", () => new net.Socket().connect(443, blocked))
await probe("tls.connect", () => tlsConnect({ host: blocked, port: 443 }))
await probe("http.get", () => http.get(`http://${blocked}/`))
await probe("https.request", () => https.request({ hostname: blocked }))
// The shared global is untouched: only this bundle's references are guarded.
out.global = globalThis.fetch.name === "guarded" ? "patched" : "untouched"
server.close()
console.log(JSON.stringify(out))
process.exit(0)
