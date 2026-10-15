import { describe as group, expect, test } from "bun:test"
import { allowed } from "../src/node/links"

group("external links", () => {
  test("web links outside the allowlist do not open; loopback and non-web schemes do", () => {
    expect(allowed("https://kilo.ai/docs")).toBe(false)
    expect(allowed("https://app.kilo.ai/credits")).toBe(false)
    expect(allowed("http://127.0.0.1:3000/")).toBe(true)
    expect(allowed("vscode://dyvoid.code-agent/callback")).toBe(true)
    expect(allowed("command:workbench.action.openSettings")).toBe(true)
  })
})

group("search helpers", () => {
  test("redacts keys in URLs and error text", async () => {
    const { redact } = await import("../src/search")
    expect(redact("403 GET https://mcp.exa.ai/mcp?exaApiKey=sk-123&x=1")).toBe("403 GET https://mcp.exa.ai/mcp?exaApiKey=[redacted]&x=1")
    expect(redact("https://h/x?api_key=abc")).toBe("https://h/x?api_key=[redacted]")
    expect(redact("no key here")).toBe("no key here")
  })
})
