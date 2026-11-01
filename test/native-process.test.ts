import { expect, test } from "bun:test"
import { runCommand } from "../src/process"
import { chmod, mkdtemp, rm, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("aborted owned process exits before rejection", async () => {
  const controller = new AbortController()
  const command = runCommand(["sleep", "30"], { signal: controller.signal })
  controller.abort()
  await expect(command).rejects.toThrow()
})

test("aborting an owned subprocess terminates its hook descendants", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ensemble-process-"))
  const controller = new AbortController()
  const pidFile = join(directory, "child.pid")
  const command = runCommand(["sh", "-c", `sleep 30 & printf '%s' $! > ${JSON.stringify(pidFile)}; wait`], { signal: controller.signal })
  try {
    while (!await Bun.file(pidFile).exists()) await Bun.sleep(5)
    const pid = Number(await Bun.file(pidFile).text())
    controller.abort(new Error("cancel owned group"))
    await expect(command).rejects.toThrow("cancel owned group")
    expect(() => process.kill(pid, 0)).toThrow("ESRCH")
  } finally {
    controller.abort()
    await command.catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

test("owned process ignoring SIGTERM settles after SIGKILL escalation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ensemble-process-escalation-"))
  const controller = new AbortController()
  const pidFile = join(directory, "owned.pid")
  const command = runCommand(["sh", "-c", `trap '' TERM; printf '%s' $$ > ${JSON.stringify(pidFile)}; exec sleep 30`], { signal: controller.signal })
  try {
    const deadline = AbortSignal.timeout(3000)
    while (!await Bun.file(pidFile).exists()) {
      deadline.throwIfAborted()
      await Bun.sleep(5)
    }
    const pid = Number(await Bun.file(pidFile).text())
    controller.abort(new Error("cancel TERM-ignoring process"))
    await expect(command).rejects.toThrow("cancel TERM-ignoring process")
    expect(() => process.kill(pid, 0)).toThrow("ESRCH")
  } finally {
    controller.abort()
    await command.catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
}, 5000)

test("cancelling Git releases ref locks before another preservation attempt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ensemble-git-cancel-"))
  const controller = new AbortController()
  const pidFile = join(directory, "hook.pid")
  const hook = join(directory, ".git/hooks/reference-transaction")
  try {
    expect((await runCommand(["git", "init", "--initial-branch=base"], { cwd: directory })).exitCode).toBe(0)
    expect((await runCommand(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "base"], { cwd: directory })).exitCode).toBe(0)
    await Bun.write(hook, `#!/bin/sh\n[ "$1" = prepared ] || exit 0\nprintf '%s' $$ > ${JSON.stringify(pidFile)}\nexec sleep 30\n`)
    await chmod(hook, 0o700)
    const command = runCommand(["git", "branch", "preserved"], { cwd: directory, signal: controller.signal })
    try {
      const deadline = AbortSignal.timeout(3000)
      while (!await Bun.file(pidFile).exists()) {
        deadline.throwIfAborted()
        await Bun.sleep(5)
      }
      const pid = Number(await Bun.file(pidFile).text())
      controller.abort(new Error("cancel Git preservation"))
      await expect(command).rejects.toThrow("cancel Git preservation")
      expect(() => process.kill(pid, 0)).toThrow("ESRCH")
    } finally {
      controller.abort()
      await command.catch(() => undefined)
    }
    await unlink(hook)
    const retry = await runCommand(["git", "branch", "preserved"], { cwd: directory })
    expect(retry.stderr).toBe("")
    expect(retry.exitCode).toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
