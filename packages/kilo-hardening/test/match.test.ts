import { describe as group, expect, test } from "bun:test"
import { allowsAddress, check, entry, loopback, normalize } from "../src/match"

group("loopback", () => {
  test("always allowed names and addresses", () => {
    for (const host of ["localhost", "LOCALHOST", "127.0.0.1", "127.8.9.10", "::1", "[::1]", "::ffff:127.0.0.1"])
      expect(loopback(host)).toBe(true)
  })

  test("lookalikes are not loopback", () => {
    for (const host of ["localhost.evil.com", "evil.localhost", "128.0.0.1", "0.0.0.0", "::"]) expect(loopback(host)).toBe(false)
  })

  test("allowed even with an empty list", () => {
    expect(check([], "127.0.0.1", 18080)).toBe("allow")
    expect(check([], "example.com", 443)).toBe("deny")
  })
})

group("entries", () => {
  test("exact host is case and trailing-dot insensitive", () => {
    const list = [entry({ host: "LLM.Corp.Example" })]
    expect(check(list, "llm.corp.example.", 443)).toBe("allow")
    expect(check(list, "x.llm.corp.example", 443)).toBe("deny")
    expect(check(list, "corp.example", 443)).toBe("deny")
  })

  test("suffix covers the apex and subdomains only on label boundaries", () => {
    const list = [entry({ suffix: ".corp.example" })]
    expect(check(list, "corp.example", 443)).toBe("allow")
    expect(check(list, "a.b.corp.example", 443)).toBe("allow")
    expect(check(list, "evilcorp.example", 443)).toBe("deny")
  })

  test("ports restrict an entry", () => {
    const list = [entry({ host: "llm.corp.example", ports: [8443] })]
    expect(check(list, "llm.corp.example", 8443)).toBe("allow")
    expect(check(list, "llm.corp.example", 443)).toBe("deny")
  })

  test("cidr matches IP literals and asks to resolve names", () => {
    const list = [entry({ cidr: "10.20.0.0/16" })]
    expect(check(list, "10.20.3.4", 80)).toBe("allow")
    expect(check(list, "10.21.0.1", 80)).toBe("deny")
    expect(check(list, "::ffff:10.20.0.9", 80)).toBe("allow")
    expect(check(list, "gpu.lan", 80)).toBe("resolve")
    expect(allowsAddress(list, "10.20.9.9", 80)).toBe(true)
    expect(allowsAddress(list, "8.8.8.8", 80)).toBe(false)
  })

  test("names are never matched by cidr without resolution", () => {
    expect(check([entry({ host: "llm.corp.example" })], "gpu.lan", 80)).toBe("deny")
  })

  test("invalid entries are rejected", () => {
    expect(() => entry({ host: "*.corp.example" })).toThrow()
    expect(() => entry({ suffix: "example" })).toThrow()
    expect(() => entry({ cidr: "10.0.0.0/33" })).toThrow()
    expect(() => entry({ host: "a", suffix: "b.c" })).toThrow()
    expect(() => entry({ host: "a.b", ports: [0] })).toThrow()
  })

  test("normalize strips brackets", () => {
    expect(normalize("[FE80::1]")).toBe("fe80::1")
  })
})
