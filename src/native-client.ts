import type { Plugin } from "@opencode/plugin"
import type { PluginClient } from "./types"
import { agentRulesAreReadOnly } from "./v2-client"
import { runCommand } from "./process"
import { setTimeout } from "node:timers/promises"

/** Native host types are resolved directly from the pinned working profile. */
export type NativeContext = Plugin.Context

/** Adapt the shared tools without granting permissions before committed placement. */
export function createNativeClient(
  ctx: NativeContext,
  signal: AbortSignal,
  admissions: Map<string, Set<string>>,
  observe: (sessionID: string) => Promise<void>,
  createdSessions?: Set<string>,
  operationAdmissions?: Map<string, Set<string>>,
): PluginClient {
  const request = { signal }
  const check = () => signal.throwIfAborted()
  const permissions = (rules: NonNullable<Parameters<PluginClient["session"]["create"]>[0]["permission"]>) =>
    rules.map((rule) => ({
      action: rule.permission === "bash" ? "shell" : rule.permission,
      resource: rule.pattern,
      effect: rule.action,
    }))
  const git = async (args: string[], cwd: string) => {
    check()
    const result = await runCommand(["git", ...args], { cwd, signal })
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed (${result.exitCode}): ${result.stderr}`)
    return result.stdout.trim()
  }
  return {
    agent: { readOnly: async (agent) => agentRulesAreReadOnly((await ctx.agent.get({ agentID: agent }, request)).data.permissions) },
    session: {
      create: async (options) => {
        check()
        const target = options.directory ?? ctx.location.directory
        const created = await ctx.session.create({
          title: options.title,
          parentID: options.parentID,
          permissions: [
            { action: "edit", resource: "*", effect: "deny" },
            { action: "shell", resource: "*", effect: "deny" },
            { action: "external_directory", resource: "*", effect: "deny" },
          ],
        }, request)
        createdSessions?.add(created.id)
        check()
        if (target !== ctx.location.directory) await ctx.session.move({ sessionID: created.id, directory: target }, request)
        // move admits a control item; its return is not committed placement.
        while (true) {
          check()
          const placed = await ctx.session.get({ sessionID: created.id }, request)
          const inbox = await ctx.session.inbox.list({ sessionID: created.id }, request)
          const active = await ctx.session.active(request)
          if (placed.location.directory === target && !inbox.length && !active[created.id]) break
          await setTimeout(5, undefined, request).catch((error) => {
            check()
            throw error
          })
        }
        check()
        await observe(created.id)
        check()
        await ctx.session.update({ sessionID: created.id, permissions: permissions(options.permission ?? []) }, request)
        check()
        return { data: { id: created.id } }
      },
      switchModel: (options) => ctx.session.switchModel({ sessionID: options.sessionID, model: { providerID: options.model.providerID, id: options.model.modelID } }, request),
      promptAsync: async (options) => {
        check()
        if (options.agent) await ctx.session.switchAgent({ sessionID: options.sessionID, agent: options.agent }, request)
        check()
        if (options.model) await ctx.session.switchModel({ sessionID: options.sessionID, model: { providerID: options.model.providerID, id: options.model.modelID } }, request)
        check()
        const id = `msg_${crypto.randomUUID().replaceAll("-", "")}`
        const owned = admissions.get(options.sessionID) ?? new Set<string>()
        admissions.set(options.sessionID, owned)
        owned.add(id)
        if (operationAdmissions) {
          const current = operationAdmissions.get(options.sessionID) ?? new Set<string>()
          current.add(id)
          operationAdmissions.set(options.sessionID, current)
        }
        const text = options.parts.map((part) => part.text).join("\n")
        if (options.synthetic) return ctx.session.synthetic({ sessionID: options.sessionID, id, text, delivery: "queue" }, request)
        return ctx.session.prompt({ sessionID: options.sessionID, id, text, delivery: "queue" }, request)
      },
      abort: async (options) => {
        check()
        const pending = await ctx.session.inbox.list({ sessionID: options.sessionID }, request)
        for (const item of pending) {
          if (!admissions.get(options.sessionID)?.has(item.id)) continue
          await ctx.session.inbox.cancel({ sessionID: options.sessionID, inboxID: item.id }, request)
        }
        await ctx.session.interrupt({ sessionID: options.sessionID }, request)
        while ((await ctx.session.active(request))[options.sessionID]) {
          await setTimeout(5, undefined, request).catch((error) => {
            check()
            throw error
          })
        }
      },
      status: async () => ({ data: Object.fromEntries(Object.entries(await ctx.session.active(request)).map(([id, value]) => [id, { type: value.type === "running" ? "busy" : value.type }])) }),
      get: async (options) => ({ data: await ctx.session.get({ sessionID: options.sessionID }, request) }),
      messages: async () => { throw new Error("Native Ensemble does not use legacy session.messages") },
    },
    tui: { showToast: async () => undefined, selectSession: async () => undefined },
    worktree: {
      create: async (options) => {
        check()
        const name = options.worktreeCreateInput?.name ?? "ensemble-worktree"
        const created = await ctx.worktree.create({ projectID: ctx.location.project.id, from: ctx.location.directory, name }, request)
        check()
        const initial = await git(["branch", "--show-current"], created.directory)
        if (!initial) await git(["switch", "-c", name], created.directory)
        const branch = await git(["branch", "--show-current"], created.directory)
        if (!branch) throw new Error(`Worktree ${created.directory} has no confirmed branch; preserved for inspection`)
        return { data: { name, branch, directory: created.directory } }
      },
      remove: async () => { throw new Error("Native spawn preserves worktree resources after failure; inspect before cleanup") },
      list: async () => ({ data: (await ctx.worktree.list({ projectID: ctx.location.project.id }, request)).map((entry) => ({ name: entry.directory.split("/").at(-1) ?? "", branch: "", directory: entry.directory })) }),
      reset: () => ctx.worktree.refresh({ projectID: ctx.location.project.id }, request),
    },
    workspace: {
      create: async () => { throw new Error("Native placement uses public session.move, not legacy workspaces") },
      remove: async () => undefined,
      list: async () => ({ data: [] }),
    },
  }
}
