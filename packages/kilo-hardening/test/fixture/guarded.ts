// Runs with the guard installed and reports what each client did as one JSON object on stdout.
import "../../src/install"
import dgram from "node:dgram"
import http from "node:http"
import https from "node:https"
import net, { connect as namedConnect, createConnection as namedCreate } from "node:net"
import tls, { connect as namedTls } from "node:tls"
import { installed } from "../../src/guard"
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
    if (url.pathname === "/file") return new Response(null, { status: 302, headers: { location: "file:///etc/hostname" } })
    if (url.pathname === "/keep") return new Response(null, { status: 307, headers: { location: "/echo" } })
    if (url.pathname === "/echo") return new Response(req.body)
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
await probe("fetch redirect flag", async () => {
  if (!(await fetch(`${base}/home`)).redirected) throw new Error("redirected is false")
})
await probe("fetch redirect to file", () => fetch(`${base}/file`))
await probe("fetch 307 replays a Request body", async () => {
  const res = await fetch(new Request(`${base}/keep`, { method: "POST", body: "hi" }))
  if ((await res.text()) !== "hi") throw new Error("body lost")
})
await probe("fetch s3 scheme", () => fetch("s3://bucket/key"))
await probe("fetch caller proxy", () => fetch(`${base}/ok`, { proxy: `http://${blocked}:3128` } as RequestInit))
await probe("fetch data with a stray env proxy", async () => (await fetch("data:text/plain,hi")).text())
await probe("Bun.file s3", () => Bun.file("s3://bucket/key").text())
await probe("WebSocket proxy option", () => new WebSocket(`ws://127.0.0.1:${server.port}/`, { proxy: `http://${blocked}:3128` } as never))
await probe("fetch.preconnect", () => (fetch as unknown as { preconnect(url: string): void }).preconnect(`https://${blocked}/`))
await probe("WebSocket", () => new WebSocket(`wss://${blocked}/`))
await probe("Bun.connect", () => Bun.connect({ hostname: blocked, port: 443, socket: { data() {} } }))
await probe("Bun.connect host", () => Bun.connect({ host: blocked, port: 443, socket: { data() {} } } as never))
await probe("Bun.udpSocket", async () => (await Bun.udpSocket({})).send("x", 53, blocked))
await probe("Bun.sql", () => (Bun as unknown as { sql: (s: string) => unknown }).sql("select 1"))
await probe("Bun.s3", () => (Bun as unknown as { s3: { file(name: string): unknown } }).s3.file("x"))
await probe("net.connect", () => net.connect(443, blocked))
await probe("net.Socket.connect", () => new net.Socket().connect({ host: blocked, port: 443 }))
await probe("tls.connect", () => tls.connect({ host: blocked, port: 443 }))
await probe("http.get", () => http.get(`http://${blocked}/`))
await probe("https.request", () => https.request({ hostname: blocked, port: 443, path: "/" }))
await probe("http.request url + options", () => http.request(`${base}/ok`, { hostname: blocked }))
await probe("http.ClientRequest", () => new http.ClientRequest(`http://${blocked}/`))
await probe("dgram.send", () => dgram.createSocket("udp4").send("x", 53, blocked))
await probe("dgram.connect", () => dgram.createSocket("udp4").connect(53, blocked))
await probe("http.ClientRequest.call", () => {
  function Legacy(this: unknown) {
    ;(http.ClientRequest as unknown as (...args: unknown[]) => unknown).call(this, `http://${blocked}/`)
  }
  Reflect.construct(Legacy, [])
})
await probe("dgram connected loopback", async () => {
  const echo = dgram.createSocket("udp4")
  const bound = Promise.withResolvers<void>()
  echo.bind(0, "127.0.0.1", () => bound.resolve())
  await bound.promise
  const client = dgram.createSocket("udp4")
  const ready = Promise.withResolvers<void>()
  client.connect(echo.address().port, "127.0.0.1", () => ready.resolve())
  await ready.promise
  const sent = Promise.withResolvers<void>()
  client.send("x", (err) => (err ? sent.reject(err) : sent.resolve()))
  await sent.promise
  client.close()
  echo.close()
})
// Bun's net/tls functions hand socket.connect pre-normalised [options, listener] arrays.
await probe("named net.connect", () => namedConnect({ host: blocked, port: 443 }))
await probe("named net.createConnection", () => namedCreate(443, blocked))
await probe("named tls.connect", () => namedTls({ host: blocked, port: 443 }))
await probe("checked marker", () => net.connect({ host: blocked, port: 443, [Symbol.for("kilo.hardening.checked")]: "localhost" } as never).destroy())
out["stray proxy"] = String(process.env.HTTPS_PROXY)
out["cli proxy"] = String(installed()?.proxy)
out.env = String(process.env.KILO_DISABLE_MODELS_FETCH)
out.experimental = String(process.env.KILO_EXPERIMENTAL_EXA)
out.denials = String(denials().length)
server.stop(true)
console.log(JSON.stringify(out))
process.exit(0)
