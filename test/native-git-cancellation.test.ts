import { expect, test } from "bun:test"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setupDeps, insertTeam, insertMember } from "./helpers"
import { executeTeamMerge } from "../src/tools/team-merge"
import { executeTeamCleanup } from "../src/tools/team-cleanup"
import { runCommand } from "../src/process"
import { createDb } from "../src/db"

for (const mode of ["merge", "merge-hook", "purge", "purge-stale"] as const) {
  test(`native ${mode} cancellation preserves a branch and SQLite metadata during actual Git deletion`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `ensemble-${mode}-cancel-`))
    const deps = setupDeps(createDb(join(directory, "ensemble.sqlite")))
    const controller = new AbortController()
    const purging = mode.startsWith("purge")
    const branch = mode === "purge-stale" ? "ensemble-t1-worker" : "ensemble/preserved/fixture/worker"
    const pidFile = join(directory, "hook.pid")
    const release = join(directory, "release")
    const git = async (...args: string[]) => {
      const result = await runCommand(["git", ...args], { cwd: directory })
      expect(result.exitCode).toBe(0)
      return result.stdout.trim()
    }
    try {
      await git("init", "--initial-branch=base")
      await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "base")
      await git("checkout", "-b", branch)
      await Bun.write(join(directory, "worker.txt"), "worker changes\n")
      await git("add", "worker.txt")
      await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "worker")
      await git("checkout", "base")
      deps.directory = directory
      deps.native = { project: "/tmp/test-project", run: async (_signal, task) => task(deps) }
      insertTeam(deps.db, "t1", "fixture", "lead", purging ? "archived" : "active")
      insertMember(deps.db, "t1", "worker", "child", "shutdown", "cancelled")
      deps.db.run("UPDATE team_member SET worktree_branch = ? WHERE session_id = 'child'", [branch])
      deps.registry.register("t1", "worker", "child")
      const preview = purging ? await executeTeamCleanup(deps, { force: false, purge: ["fixture"] }, "lead") : ""
      const token = preview.match(/Confirmation token: (\S+)/)?.[1]
      if (purging) {
        expect(token).toBeDefined()
        const approval = deps.purgeApprovals.approvalLabel(token!)
        const denial = deps.purgeApprovals.denialLabel(token!)
        deps.purgeApprovals.recordQuestionAnswer("lead", `User has answered your questions: "Delete?"="${approval}".`, {
          questions: [{ question: "Delete?", header: "Confirm Purge", options: [{ label: approval, description: "Delete fixture" }, { label: denial, description: "Keep fixture" }], multiple: false }],
        })
      }
      const hook = join(directory, mode === "merge-hook" ? ".git/hooks/post-merge" : ".git/hooks/reference-transaction")
      const block = `printf '%s' $$ > ${JSON.stringify(pidFile)}\nwhile [ ! -f ${JSON.stringify(release)} ]; do sleep 0.01; done\n`
      await Bun.write(hook, mode === "merge-hook" ? `#!/bin/sh\n${block}` : `#!/bin/sh\n[ "$1" = prepared ] || exit 0\nwhile read old new ref; do\n  [ "$ref" = "refs/heads/${branch}" ] || continue\n  ${block}done\n`)
      await chmod(hook, 0o700)
      deps.signal = controller.signal
      const command = !purging
        ? executeTeamMerge(deps, { member: "worker" }, "lead")
        : executeTeamCleanup(deps, { force: false, purge: ["fixture"], confirm_purge: true, confirm_token: token! }, "lead")
      const settled = command.then(() => false, () => true)
      try {
        const deadline = AbortSignal.timeout(5000)
        while (!await Bun.file(pidFile).exists()) {
          deadline.throwIfAborted()
          await Bun.sleep(5)
        }
        const pid = Number(await Bun.file(pidFile).text())
        controller.abort(new Error(`cancel ${mode} Git deletion`))
        await Bun.sleep(100)
        await Bun.write(release, "release\n")
        expect(await settled).toBe(true)
        expect(await git("branch", "--list", branch, "--format=%(refname:short)")).toBe(branch)
        expect(deps.db.query("SELECT worktree_branch FROM team_member WHERE session_id = 'child'").get()).toMatchObject({ worktree_branch: branch })
        expect(deps.db.query("SELECT status FROM team WHERE id = 't1'").get()).toMatchObject({ status: purging ? "archived" : "active" })
        expect(deps.registry.getBySession("child")).toBeDefined()
        expect(() => process.kill(pid, 0)).toThrow("ESRCH")
        if (!purging) expect(await Bun.file(join(directory, "worker.txt")).text()).toBe("worker changes\n")
        if (mode === "merge-hook") expect(await git("diff", "--cached", "--name-only")).toBe("worker.txt")
        expect(deps.client.calls).toHaveLength(0)
      } finally {
        controller.abort()
        await Bun.write(release, "release\n")
        await settled
      }
    } finally {
      deps.db.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 10000)
}
