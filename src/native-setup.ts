import { Schema } from "effect"
import { scheduler } from "node:timers/promises"
import type { NativeContext } from "./native-client"
import { createNativeClient } from "./native-client"
import type { EnsembleHandle, SetupOptions } from "./v2-setup"
import type { ToolDeps } from "./types"
import { createDb } from "./db"
import { MemberRegistry, DescendantTracker, PendingPurgeApprovals } from "./state"
import { ProgressTracker } from "./progress"
import { loadConfig } from "./config"
import { rehydrateRegistry } from "./recovery"
import { registerV2Tools } from "./v2-tools"
import { EnsembleRpc } from "./rpc"
import { dispatchV2Event } from "./v2-events"
import { checkToolIsolation, shouldNudgeIdleMember } from "./hooks"
import { buildLeadSystemPrompt, buildTeammateSystemPrompt, buildTeamCompactionContext } from "./system-prompt"
import { findTeamBySession } from "./types"
import { extractQuestionOutput } from "./v2-setup"
import { startDashboard, type DashboardServer } from "./dashboard"
import { ActivityBuffer } from "./activity"
import { vlog } from "./log"

/** Initialize the isolated native profile without V1 recovery or startup wakes. */
export async function setupEnsemble(ctx: NativeContext, options: SetupOptions): Promise<EnsembleHandle> {
  if (!options.dbPath) throw new Error("Native Ensemble requires an explicit dbPath")
  const db = createDb(options.dbPath)
  const registry = new MemberRegistry()
  const tracker = new DescendantTracker()
  const project = ctx.location.project.canonical
  const config = loadConfig(ctx.location.directory)
  const controller = new AbortController()
  const tasks = new Set<Promise<unknown>>()
  const registrations: Array<{ dispose(): Promise<void> }> = []
  const admissions = new Map<string, Set<string>>()
  const observed = new Map<string, Promise<void>>()
  const cursors = new Map<string, number>()
  const nudged = new Set<string>()
  let dashboard: DashboardServer | null | undefined
  let disposing: Promise<void> | undefined
  const cancelOwned = (owned: Map<string, Set<string>>) => Promise.allSettled([...owned].map(async ([sessionID, ids]) => {
    for (const item of await ctx.session.inbox.list({ sessionID })) {
      if (ids.has(item.id)) await ctx.session.inbox.cancel({ sessionID, inboxID: item.id })
    }
  }))
  const dispose = () => disposing ??= (async () => {
    controller.abort()
    const released = await Promise.allSettled(registrations.map((registration) => registration.dispose()))
    while (tasks.size) await Promise.allSettled([...tasks])
    const cancelled = await cancelOwned(admissions)
    try {
      const errors = [...released, ...cancelled].flatMap((result) => result.status === "rejected" ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, "Ensemble cleanup failed")
    } finally {
      dashboard?.stop()
      db.close()
    }
  })()
  const track = <T>(task: Promise<T>): Promise<T> => {
    tasks.add(task)
    void task.finally(() => tasks.delete(task)).catch(() => undefined)
    return task
  }
  try {
  const rpc = await ctx.rpc.register(EnsembleRpc, {
    summary: async (input) => {
      const { team } = Schema.decodeUnknownSync(Schema.Struct({ team: Schema.String }))(input)
      const row = db.query("SELECT id, status FROM team WHERE name = ? AND project_id = ? AND status = 'active'").get(team, project) as { id: string; status: string } | null
      if (!row) return { text: `No team "${team}".` }
      const members = db.query("SELECT name, status FROM team_member WHERE team_id = ?").all(row.id) as Array<{ name: string; status: string }>
      return { text: `Team "${team}" (${row.status}): ${members.map((member) => `${member.name}: ${member.status}`).join(", ") || "no members"}` }
    },
    teamContext: async (input) => {
      const { sessionID } = Schema.decodeUnknownSync(Schema.Struct({ sessionID: Schema.String }))(input)
      const owned = db.query("SELECT id FROM team WHERE project_id = ? AND status = 'active' AND (lead_session_id = ? OR id IN (SELECT team_id FROM team_member WHERE session_id = ?))").get(project, sessionID, sessionID) as { id: string } | null
      const team = owned && findTeamBySession(db, registry, sessionID)
      if (!team) return { team: null, members: [], tasks: { pending: 0, done: 0 } }
      const members = db.query("SELECT name, status FROM team_member WHERE team_id = ?").all(team.teamId) as Array<{ name: string; status: string }>
      const counts = db.query("SELECT SUM(status != 'completed') AS pending, SUM(status = 'completed') AS done FROM team_task WHERE team_id = ?").get(team.teamId) as { pending: number | null; done: number | null }
      return { team: team.teamName, members, tasks: { pending: counts.pending ?? 0, done: counts.done ?? 0 } }
    },
  })
  registrations.push(rpc)
  const dispatch: EnsembleHandle["dispatch"] = async (event) => {
    if (controller.signal.aborted) return
    const transition = dispatchV2Event(db, registry, tracker, event)
    if (!transition) return
    await rpc.events.emit("member", { ...transition })
    if (event.type !== "session.execution.succeeded" || transition.to !== "ready") return
    const entry = registry.getByName(transition.teamId, transition.memberName)
    if (!entry || nudged.has(entry.sessionId) || !shouldNudgeIdleMember(db, transition.teamId, transition.memberName)) return
    const row = db.query("SELECT last_nudged_at FROM team_member WHERE session_id = ?").get(entry.sessionId) as { last_nudged_at: number | null }
    if (row.last_nudged_at) return
    nudged.add(entry.sessionId)
    db.run("UPDATE team_member SET last_nudged_at = ? WHERE session_id = ?", [Date.now(), entry.sessionId])
    await client.session.promptAsync({ sessionID: entry.sessionId, synthetic: true, parts: [{ type: "text", text: "[System]: Send your findings to the lead via team_message now." }] })
  }
  const observe = async (sessionID: string) => {
    if (observed.has(sessionID)) return
    const ready = Promise.withResolvers<void>()
    const running = track((async () => {
      let synced = false
      try {
        for await (const event of ctx.session.log({ sessionID, after: cursors.get(sessionID), follow: true }, { signal: controller.signal })) {
          if (controller.signal.aborted) break
          if (event.type === "log.synced") {
            synced = true
            ready.resolve()
            continue
          }
          if (event.durable) {
            if (event.durable.seq <= (cursors.get(sessionID) ?? -1)) continue
            cursors.set(sessionID, event.durable.seq)
          }
          // Startup replay only reconstructs a cursor. It never retries provider work.
          if (synced) await dispatch(event)
        }
      } catch (error) {
        if (!controller.signal.aborted) vlog(`native:member-log:failed session=${sessionID} error=${String(error)}`)
        ready.reject(error)
      } finally {
        ready.resolve()
      }
    })())
    observed.set(sessionID, running)
    await ready.promise
  }
  const client = createNativeClient(ctx, controller.signal, admissions, observe)
  const deps: ToolDeps = {
    db, registry, tracker, client, directory: ctx.location.directory, config,
    purgeApprovals: new PendingPurgeApprovals(), progressTracker: new ProgressTracker(),
    native: {
      project,
      run: (signal, task) => {
        controller.signal.throwIfAborted()
        const operation = new AbortController()
        const combined = AbortSignal.any([controller.signal, operation.signal, ...(signal ? [signal] : [])])
        const timer = setTimeout(() => operation.abort(new Error("Ensemble operation timed out")), Number(process.env.SPAWN_TIMEOUT_MS) || 120_000)
        const created = new Set<string>()
        const owned = new Map<string, Set<string>>()
        const scoped = createNativeClient(ctx, combined, admissions, observe, created, owned)
        const prompt = scoped.session.promptAsync
        scoped.session.promptAsync = (input) => track(prompt(input))
        return track(task({ ...deps, signal: combined, client: scoped }).catch(async (error) => {
          const cancelled = await cancelOwned(owned)
          const revoked = await Promise.allSettled([...created].map(async (sessionID) => {
            try {
              try {
                await ctx.session.interrupt({ sessionID })
                while ((await ctx.session.active())[sessionID]) await scheduler.wait(5)
              } finally {
                await ctx.session.update({ sessionID, permissions: [
                  { action: "edit", resource: "*", effect: "deny" },
                  { action: "shell", resource: "*", effect: "deny" },
                  { action: "external_directory", resource: "*", effect: "deny" },
                ] })
              }
            } finally {
              db.run("UPDATE team_member SET status = 'error', execution_status = 'cancelled', time_updated = ? WHERE session_id = ?", [Date.now(), sessionID])
            }
          }))
          const errors = [...cancelled, ...revoked].flatMap((result) => result.status === "rejected" ? [result.reason] : [])
          if (errors.length) throw new AggregateError([error, ...errors], "Ensemble operation failed; owned resource cleanup also failed", { cause: error })
          throw error
        }).finally(() => clearTimeout(timer)))
      },
    },
  }
  rehydrateRegistry(db, registry, project)
  await Promise.all([...registry.allSessionIds()].map(observe))
   registrations.push(await ctx.tool.hook("execute.before", async (event) => {
     if (!event.tool.startsWith("team_")) return
     // Member log streams cannot observe creation of a different Session aggregate.
     if (!registry.isTeamSession(event.sessionID)) {
       let current: string = event.sessionID
       for (let depth = 0; depth < 10; depth++) {
         const parent = tracker.getParent(current) ?? (await ctx.session.get({ sessionID: current }, { signal: controller.signal })).parentID
         if (!parent) break
         tracker.track(current, parent)
         if (registry.isTeamSession(parent)) break
         current = parent
       }
     }
     checkToolIsolation(registry, tracker, event.tool, event.sessionID, db)
    const foreign = db.query("SELECT id FROM team WHERE project_id != ? AND (lead_session_id = ? OR id IN (SELECT team_id FROM team_member WHERE session_id = ?))").get(project, event.sessionID, event.sessionID)
    if (foreign) throw new Error("Team belongs to another project")
  }))
  registrations.push(await ctx.tool.hook("execute.after", (event) => {
    if (event.tool === "question" && event.status === "completed") deps.purgeApprovals.recordQuestionAnswer(event.sessionID, extractQuestionOutput(event.result), event.input)
  }))
  registrations.push(await ctx.session.hook("context", (event) => {
    const team = findTeamBySession(db, registry, event.sessionID)
    if (!team) return
    const owned = db.query("SELECT id FROM team WHERE id = ? AND project_id = ?").get(team.teamId, project)
    if (!owned) return
    event.system.push({ type: "text", text: team.role === "lead" ? buildLeadSystemPrompt(db, team.teamId, config) : buildTeammateSystemPrompt(db, team.teamId, team.memberName ?? "unknown") })
  }))
  registrations.push(await ctx.session.hook("compaction", (event) => {
    const team = findTeamBySession(db, registry, event.sessionID)
    if (!team || !db.query("SELECT id FROM team WHERE id = ? AND project_id = ?").get(team.teamId, project)) return
    event.system.push({ type: "text", text: buildTeamCompactionContext(db, team.teamId, team.role, team.memberName) })
  }))
  await registerV2Tools({ transform: (callback) => ctx.tool.transform((editor) => callback({
    add: (definition) => editor.add({
      ...definition, input: definition.input, output: Schema.String,
      execute: async (input, context) => {
        const result = await definition.execute(input, context)
        return { output: result.content, content: result.content }
      },
    }),
  })).then((registration) => { registrations.push(registration); return registration }) }, deps)
  dashboard = options.dashboardPort ? await startDashboard(db, options.dashboardPort, { activityBuffer: new ActivityBuffer(), client }) : undefined
  return {
    db, registry, tracker, dispatch,
    dispose,
  }
  } catch (error) {
    await dispose()
    throw error
  }
}
