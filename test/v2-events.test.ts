import { describe, expect, test } from "bun:test"
import { createDb } from "../src/db"
import { MemberRegistry, DescendantTracker } from "../src/state"
import { dispatchV2Event } from "../src/v2-events"

/** Live V2 event shapes (from @opencode/client `V2Event` union, v2.0.3). */
function statusEvent(sessionID: string, status: string) {
  return { type: "session.status", data: { sessionID, status } }
}

function seedTeam() {
  const db = createDb(":memory:")
  const now = Date.now()
  db.run(
    "INSERT INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated) VALUES (?, ?, ?, 'active', 0, ?, ?)",
    ["team1", "alpha", "ses_lead", now, now],
  )
  db.run(
    "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ["team1", "alice", "ses_alice", "build", "busy", "running", now, now],
  )
  const registry = new MemberRegistry()
  registry.register("team1", "alice", "ses_alice")
  return { db, registry, tracker: new DescendantTracker() }
}

describe("v2-events (issue #36, DRY: reuses hooks.ts)", () => {
  test("session.status idle transitions a busy member to ready", () => {
    const { db, registry, tracker } = seedTeam()
    const transition = dispatchV2Event(db, registry, tracker, statusEvent("ses_alice", "idle"))
    expect(transition).toMatchObject({ memberName: "alice", to: "ready" })
    const row = db.query("SELECT status FROM team_member WHERE name = 'alice'").get() as { status: string }
    expect(row.status).toBe("ready")
  })

  test("session.idle is equivalent to status idle", () => {
    const { db, registry, tracker } = seedTeam()
    const transition = dispatchV2Event(db, registry, tracker, {
      type: "session.idle",
      data: { sessionID: "ses_alice" },
    })
    expect(transition).toMatchObject({ memberName: "alice", to: "ready" })
  })

  test("session.execution.started marks busy, succeeded marks ready", () => {
    const { db, registry, tracker } = seedTeam()
    db.run("UPDATE team_member SET status = 'ready' WHERE name = 'alice'")
    const started = dispatchV2Event(db, registry, tracker, {
      type: "session.execution.started",
      data: { sessionID: "ses_alice" },
    })
    expect(started).toMatchObject({ to: "busy" })
    const done = dispatchV2Event(db, registry, tracker, {
      type: "session.execution.succeeded",
      data: { sessionID: "ses_alice" },
    })
    expect(done).toMatchObject({ to: "ready" })
  })

  test("session.created tracks parent for sub-agent isolation", () => {
    const { db, registry, tracker } = seedTeam()
    dispatchV2Event(db, registry, tracker, {
      type: "session.created",
      data: { sessionID: "ses_child", parentID: "ses_alice" },
    })
    expect(tracker.isDescendantOf("ses_child", new Set(["ses_alice"]))).toBe(true)
  })

  test.each([
    ["session.execution.failed", undefined, "error", "failed"],
    ["session.execution.interrupted", "user", "error", "cancelled"],
    ["session.execution.interrupted", "shutdown", "shutdown", "cancelled"],
  ])("%s records a terminal result without successful idle", (type, reason, status, execution) => {
    const { db, registry, tracker } = seedTeam()
    try {
      const event = { type: type ?? "", data: { sessionID: "ses_alice", reason } }
      expect(dispatchV2Event(db, registry, tracker, event)).toMatchObject({ to: status })
      expect(db.query("SELECT status, execution_status FROM team_member WHERE name = 'alice'").get()).toMatchObject({ status, execution_status: execution })
      expect(dispatchV2Event(db, registry, tracker, event)).toBeUndefined()
    } finally {
      db.close()
    }
  })

  test("session.retry.scheduled persists retry columns without changing status", () => {
    const { db, registry, tracker } = seedTeam()
    const transition = dispatchV2Event(db, registry, tracker, {
      type: "session.retry.scheduled",
      data: { sessionID: "ses_alice", attempt: 2, at: 9999, error: { message: "throttled" } },
    })
    expect(transition).toMatchObject({ to: "retry" })
    const row = db.query(
      "SELECT status, retry_attempt FROM team_member WHERE name = 'alice'",
    ).get() as { status: string; retry_attempt: number }
    expect(row.status).toBe("busy")
    expect(row.retry_attempt).toBe(2)
  })

  test("unknown sessions and unrelated event types are ignored", () => {
    const { db, registry, tracker } = seedTeam()
    expect(dispatchV2Event(db, registry, tracker, statusEvent("ses_ghost", "idle"))).toBeUndefined()
    expect(
      dispatchV2Event(db, registry, tracker, { type: "tui.toast.show", data: {} }),
    ).toBeUndefined()
  })
})
