// Runs with the guard installed and reports what each client did as one JSON object on stdout.
import "../../src/install"
import http from "node:http"
import https from "node:https"
import net from "node:net"
import tls from "node:tls"
import { denials } from "../../src/log"

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

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/away") return Response.redirect(`https://${blocked}/x`, 302)
    if (url.pathname === "/home") return Response.redirect(`/ok`, 302)
    return new Response("ok")
  },
})
const base = `http://127.0.0.1:${server.port}`

await probe("fetch loopback", async () => (await fetch(`${base}/ok`)).text())
await probe("fetch blocked", () => fetch(`https://${blocked}/`))
await probe("fetch redirect to blocked", () => fetch(`${base}/away`))
await probe("fetch redirect same host", async () => {
  const res = await fetch(`${base}/home`)
  if ((await res.text()) !== "ok") throw new Error("wrong body")
})
await probe("fetch manual redirect", async () => {
  const res = await fetch(`${base}/away`, { redirect: "manual" })
  if (res.status !== 302) throw new Error(`status ${res.status}`)
})
await probe("WebSocket", () => new WebSocket(`wss://${blocked}/`))
await probe("Bun.connect", () => Bun.connect({ hostname: blocked, port: 443, socket: { data() {} } }))
await probe("net.connect", () => net.connect(443, blocked))
await probe("net.Socket.connect", () => new net.Socket().connect({ host: blocked, port: 443 }))
await probe("tls.connect", () => tls.connect({ host: blocked, port: 443 }))
await probe("http.get", () => http.get(`http://${blocked}/`))
await probe("https.request", () => https.request({ hostname: blocked, port: 443, path: "/" }))
out.env = String(process.env.KILO_DISABLE_MODELS_FETCH)
out.experimental = String(process.env.KILO_EXPERIMENTAL_EXA)
out.denials = String(denials().length)
server.stop(true)
console.log(JSON.stringify(out))
process.exit(0)
