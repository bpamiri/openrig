import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { activityRoutes } from "../src/routes/activity.js";

// The dsh runner announces the ACP session id in a session_identity post. The token is
// id-shaped, so the hooks route takes the strict OMP-like path: exact seat, the seat's own
// runtime, the current occupant generation, and agreement with the runner's own sidecar.

const TOKEN = "dsh-hook-token";
const SESSION = "dev-impl@dsh-rig";
const SESSION_ID = "session-4f7c2d1e-8a5b-4c3d-9e2f-6a1b0c9d8e7f";

const openDbs: Array<() => void> = [];
afterEach(() => { for (const close of openDbs.splice(0)) close(); });

function makeApp(sidecarSessionId: string | null) {
  const db: Database.Database = createFullTestDb();
  openDbs.push(() => db.close());
  const rigs = new RigRepository(db);
  const rig = rigs.createRig("dsh-routerig");
  const node = rigs.addNode(rig.id, "dev.impl", { runtime: "dsh", cwd: "/work" });
  const sessions = new SessionRegistry(db);
  const session = sessions.registerClaimedSession(node.id, SESSION);
  const generation = sessions.currentOccupantTenure(node.id)!.generationUuid;
  const eventBus = new EventBus(db);

  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("agentActivityStore" as never, new AgentActivityStore({ db, eventBus }) as never);
    c.set("activityHookToken" as never, TOKEN as never);
    c.set("sessionRegistry" as never, sessions as never);
    c.set("eventBus" as never, eventBus as never);
    c.set("runtimeAdapters" as never, {
      dsh: { readSessionId: () => sidecarSessionId === null ? { ok: false as const, reason: "missing_sidecar" } : { ok: true as const, sessionId: sidecarSessionId } },
    } as never);
    await next();
  });
  app.route("/api/activity", activityRoutes);

  const post = (body: Record<string, unknown>) => app.request("/api/activity/hooks", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  const identity = (overrides: Record<string, unknown> = {}) => post({
    eventFamily: "session_identity",
    hookEvent: "SessionStart",
    runtime: "dsh",
    sessionName: SESSION,
    nodeId: node.id,
    sessionId: SESSION_ID,
    generation,
    ...overrides,
  });
  return { db, node, session, sessions, generation, identity };
}

describe("dsh session_identity hooks route", () => {
  it("persists the ACP session id when the current occupant's runner sidecar agrees", async () => {
    const { sessions, session, identity } = makeApp(SESSION_ID);
    const res = await identity();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, tokenPersisted: true });
    expect(sessions.resumeTokenMatches(session.id, "dsh_session_id", SESSION_ID)).toBe(true);
  });

  it("does not persist when the runner sidecar names a different session", async () => {
    const { sessions, session, identity } = makeApp("session-other");
    const res = await identity();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, tokenPersisted: false });
    expect(sessions.resumeTokenMatches(session.id, "dsh_session_id", SESSION_ID)).toBe(false);
  });

  it("refuses a post whose runtime contradicts the managed seat", async () => {
    const { identity } = makeApp(SESSION_ID);
    const res = await identity({ runtime: "claude-code" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: "runtime_mismatch", tokenPersisted: false });
  });

  it("refuses a post that cannot name the current occupant generation", async () => {
    const { identity } = makeApp(SESSION_ID);
    const res = await identity({ generation: null });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: "generation_unverifiable", tokenPersisted: false });
  });
});
