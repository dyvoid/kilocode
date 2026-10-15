import { describe as group, expect, test } from "bun:test"
import { allowed } from "../src/node/links"

group("external links", () => {
  test("web links outside the allowlist do not open; loopback, mailto and our own URI handler do", () => {
    expect(allowed("https://kilo.ai/docs")).toBe(false)
    expect(allowed("https://app.kilo.ai/credits")).toBe(false)
    expect(allowed("http://127.0.0.1:3000/")).toBe(true)
    expect(allowed("vscode://dyvoid.code-agent/callback")).toBe(true)
    expect(allowed("mailto:it@example.com")).toBe(true)
  })

  test("schemes whose handlers connect on their own do not open", () => {
    for (const link of [
      "vscode://vscode.git/clone?url=https%3A%2F%2Fevil.example%2Frepo",
      "ssh://evil.example/",
      "file://evil.example/share",
      "smb://evil.example/share",
      "ftp://evil.example/",
      "command:workbench.action.openSettings",
      "not a url",
    ])
      expect(allowed(link)).toBe(false)
  })

  test("the encoded form is what gets checked", () => {
    // vscode.Uri#toString() keeps %2F encoded; WHATWG parsing then sees evil.example as the host.
    expect(allowed("https://localhost%2F@evil.example/")).toBe(false)
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
