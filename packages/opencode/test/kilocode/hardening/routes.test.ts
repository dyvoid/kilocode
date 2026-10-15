import { describe, expect, test } from "bun:test"
import { refused, requestPath } from "../../../src/kilocode/server/httpapi/hardening"

describe("hardening route gate", () => {
  test("cloud routes are refused however the path is spelled", () => {
    for (const path of [
      "/kilo/profile",
      "/KILO/profile",
      "/%6Bilo/profile",
      "/%6bilo/profile",
      "/kilo//profile",
      "//kilo/profile",
      "/kilocode/Marketplace",
      "/%72emote/status",
      "/kilocode/%2e%2e/kilo/profile",
      "/kilo/%zz",
      "/kilo%2Fprofile",
      "/global/upgrade",
    ])
      expect(refused(path)).toBe(true)
  })

  test("other routes are served", () => {
    for (const path of ["/session", "/provider", "/kilocode/skills", "/kilocodex/marketplace", "/remotes", "/%zz"])
      expect(refused(path)).toBe(path === "/%zz")
  })

  test("request URLs keep a leading double slash as part of the path", () => {
    for (const url of ["//indexing/models", "///kilo/profile", "/\\kilo/profile", "//%6bilo/profile?x=1", "//global/upgrade#a"])
      expect(refused(requestPath(url))).toBe(true)
    expect(requestPath("/session?x=//kilo/profile")).toBe("/session")
    expect(requestPath("http://localhost:4096//kilo/profile")).toBe("//kilo/profile")
  })
})
