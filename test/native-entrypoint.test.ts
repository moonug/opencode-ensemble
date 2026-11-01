import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

test("directory-native root and companions exist without importing the V1 entry", async () => {
  expect(existsSync(resolve(import.meta.dir, "../server.ts"))).toBe(true)
  expect(existsSync(resolve(import.meta.dir, "../tui.tsx"))).toBe(true)
  expect(existsSync(resolve(import.meta.dir, "../rpc.ts"))).toBe(true)
  const source = await Bun.file(resolve(import.meta.dir, "../server.ts")).text()
  expect(source).not.toContain("src/index")
})

test("directory-native server and companions load their actual exported definitions", async () => {
  const server = await import("../server")
  const rpc = await import("../rpc")
  const tui = await import("../tui")
  expect(server.default.id).toBe("ensemble")
  expect(typeof server.default.setup).toBe("function")
  expect(rpc.EnsembleRpc.id).toBe("ensemble")
  expect(Object.keys(rpc.EnsembleRpc.methods)).toEqual(["summary", "teamContext"])
  expect(tui.default.id).toBe("ensemble.tui")
  expect(typeof tui.default.setup).toBe("function")
})
