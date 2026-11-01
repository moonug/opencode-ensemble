import { Buffer } from "node:buffer"
import { spawn } from "node:child_process"
import type { Readable } from "node:stream"

export interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface CommandOptions {
  cwd?: string
  signal?: AbortSignal
}

function collect(stream: Readable | null, chunks: Buffer[]): void {
  stream?.on("data", (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  })
}

/** Run a subprocess with Node-compatible APIs and capture stdout/stderr. */
export function runCommand(args: string[], options: CommandOptions = {}): Promise<CommandResult> {
  options.signal?.throwIfAborted()
  const [command, ...commandArgs] = args
  if (!command) return Promise.resolve({ exitCode: 1, stdout: "", stderr: "No command provided" })

  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    let kill: ReturnType<typeof setTimeout> | undefined
    const finish = (result: CommandResult) => {
      if (settled) return
      settled = true
      clearTimeout(kill)
      options.signal?.removeEventListener("abort", abort)
      if (options.signal?.aborted) {
        reject(options.signal.reason)
        return
      }
      resolve(result)
    }

    const child = spawn(command, commandArgs, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    })
    const stop = (signal: "SIGTERM" | "SIGKILL") => {
      if (process.platform === "win32" || !child.pid) {
        child.kill(signal)
        return
      }
      // Git hooks inherit this owned process group, not the host's group.
      try { process.kill(-child.pid, signal) } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error
      }
    }
    const abort = () => {
      stop("SIGTERM")
      kill = setTimeout(() => stop("SIGKILL"), 1000)
    }
    options.signal?.addEventListener("abort", abort, { once: true })
    if (options.signal?.aborted) abort()

    collect(child.stdout, stdout)
    collect(child.stderr, stderr)

    child.on("error", (error) => {
      finish({ exitCode: 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: error.message })
    })
    child.on("close", (code) => {
      finish({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      })
    })
  })
}
