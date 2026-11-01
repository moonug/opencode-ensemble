import { expect, test } from "bun:test"
import { setupDeps, insertTeam, insertMember } from "./helpers"
import { executeTeamCleanup } from "../src/tools/team-cleanup"
import { executeTeamShutdown } from "../src/tools/team-shutdown"

test("native cleanup retains a running shutdown_requested member and its registry", async () => {
  const deps = setupDeps()
  try {
    deps.native = { project: deps.directory, run: async (_signal, task) => task(deps) }
    insertTeam(deps.db, "t1", "fixture", "lead")
    insertMember(deps.db, "t1", "worker", "child", "shutdown_requested", "running")
    deps.registry.register("t1", "worker", "child")
    await expect(executeTeamCleanup(deps, { force: false }, "lead")).rejects.toThrow("still active")
    expect(deps.db.query("SELECT status FROM team WHERE id = 't1'").get()).toMatchObject({ status: "active" })
    expect(deps.registry.getBySession("child")).toBeDefined()
    expect(deps.client.calls).toHaveLength(0)
  } finally {
    deps.db.close()
  }
})

test("native cleanup passes cancellation into overlap and merge and never archives after abort", async () => {
  const deps = setupDeps()
  const controller = new AbortController()
  try {
    deps.native = { project: deps.directory, run: async (_signal, task) => task(deps) }
    deps.signal = controller.signal
    insertTeam(deps.db, "t1", "fixture", "lead")
    insertMember(deps.db, "t1", "worker", "child", "shutdown", "cancelled")
    deps.registry.register("t1", "worker", "child")
    deps.db.run("UPDATE team_member SET worktree_branch = 'fixture' WHERE session_id = 'child'")
    const reason = new Error("cancel cleanup")
    await expect(executeTeamCleanup(deps, { force: false }, "lead", undefined,
      async (_branch, _cwd, signal) => {
        expect(signal).toBe(controller.signal)
        signal?.throwIfAborted()
        throw new Error("merge continued after cancellation")
      }, undefined, true,
      async (_branch, _cwd, signal) => {
        expect(signal).toBe(controller.signal)
        controller.abort(reason)
        return []
      },
    )).rejects.toBe(reason)
    expect(deps.db.query("SELECT status FROM team WHERE id = 't1'").get()).toMatchObject({ status: "active" })
    expect(deps.registry.getBySession("child")).toBeDefined()
    expect(deps.client.calls).toHaveLength(0)
  } finally {
    deps.db.close()
  }
})

test("native shutdown records shutdown_requested before failed branch preservation and sends no prompt", async () => {
  const deps = setupDeps()
  try {
    deps.native = { project: deps.directory, run: async (_signal, task) => task(deps) }
    insertTeam(deps.db, "t1", "fixture", "lead")
    insertMember(deps.db, "t1", "worker", "child", "busy", "running")
    deps.registry.register("t1", "worker", "child")
    deps.db.run("UPDATE team_member SET worktree_branch = 'fixture' WHERE session_id = 'child'")
    await expect(executeTeamShutdown(deps, { member: "worker", force: true }, "lead", undefined,
      async () => {
        expect(deps.db.query("SELECT status FROM team_member WHERE session_id = 'child'").get()).toMatchObject({ status: "shutdown_requested" })
        return false
      },
    )).rejects.toThrow("Cannot preserve")
    expect(deps.client.calls.map((call) => call.method)).toEqual(["session.status"])
    expect(deps.db.query("SELECT status FROM team_member WHERE session_id = 'child'").get()).toMatchObject({ status: "shutdown_requested" })
  } finally {
    deps.db.close()
  }
})
