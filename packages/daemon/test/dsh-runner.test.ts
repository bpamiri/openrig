// OPR.0.6.DSH1 — hermetic tests for the dsh runner core and its argv contract.
// The core reaches the outside world only through DshRunnerIo, so every decision
// (readiness, the sidecar, one-prompt-in-flight queueing, permission answers,
// occupant-bound activity, honest death reporting) is testable with no dsh, no
// tmux and no model.

import { describe, it, expect } from "vitest";
import {
  DshRunnerCore, MAX_DSH_INPUT_BYTES, describeDshDecision, describeDshPermission, dshPermissionDecision,
  parseDshRunnerArgs,
  type DshActivityPayload, type DshRunnerIo, type DshRunnerTransport,
} from "../src/adapters/dsh-runner.js";
import { DSH_RUNNER_ERROR_MARKER, DSH_RUNNER_EXIT_MARKER, DSH_RUNNER_READY_MARKER, type DshRunnerState } from "../src/adapters/dsh-runner-protocol.js";

const SESSION = "dev1-dsh@dsh-scratch";
const SESSION_ID = "session-fac46d5a-82c0-4687-b95d-b1c9dc0bfbc";

function fakeIo() {
  const appends: string[] = [];
  const thoughts: string[] = [];
  const lines: string[] = [];
  const activity: DshActivityPayload[] = [];
  const sidecars: DshRunnerState[] = [];
  const io: DshRunnerIo = {
    mirrorAppend: (text) => appends.push(text),
    mirrorThought: (text) => thoughts.push(text),
    mirrorLine: (line) => lines.push(line),
    postActivity: (payload) => activity.push(payload),
    writeSidecar: (state) => sidecars.push(state),
    now: () => "2026-10-15T10:00:00.000Z",
  };
  return { io, appends, thoughts, lines, activity, sidecars };
}

function fakeTransport() {
  const prompts: Array<{ sessionId: string; text: string }> = [];
  const cancels: string[] = [];
  const closes: string[] = [];
  const disposals: number[] = [];
  const deferred: Array<{ resolve: (reason: string) => void; reject: (error: Error) => void }> = [];
  const transport: DshRunnerTransport = {
    prompt: (opts) => new Promise<{ stopReason: string }>((resolve, reject) => {
      prompts.push(opts);
      deferred.push({ resolve: (reason) => resolve({ stopReason: reason }), reject });
    }),
    cancel: (sessionId) => { cancels.push(sessionId); },
    closeSession: async (sessionId) => { closes.push(sessionId); },
    dispose: async () => { disposals.push(1); },
  };
  return {
    transport, prompts, cancels, closes, deferred, disposals,
    finishTurn: (reason = "end_turn") => { const turn = deferred.shift(); if (!turn) throw new Error("no prompt is in flight"); turn.resolve(reason); },
    failTurn: (message: string) => { const turn = deferred.shift(); if (!turn) throw new Error("no prompt is in flight"); turn.reject(new Error(message)); },
    pendingTurns: () => deferred.length,
  };
}

function makeCore(f = fakeIo(), t = fakeTransport(), opts: { posture?: "floor" | "auto" | "full_bypass" } = {}) {
  const posture = opts.posture ?? "floor";
  const core = new DshRunnerCore(f.io, {
    sessionName: SESSION,
    cwd: "/repo",
    launchId: "launch-77",
    posture,
    permissionMode: posture === "full_bypass" ? "danger-full-access" : "workspace-write",
    nodeId: "node-1",
    generation: "gen-1",
    runtime: "dsh",
  }, { sessionId: SESSION_ID });
  core.attachTransport(t.transport);
  return { core, ...f, ...t };
}

// A turn's settle path is `.then().catch().finally()`, so a single macrotask
// tick is not always enough to observe the post-turn state.
const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("runner argv contract", () => {
  const required = [
    "--session-name", SESSION, "--state-root", "/state/dsh", "--dsh-home", "/state/dsh/h",
    "--cwd", "/repo", "--launch-id", "launch-1", "--posture", "auto",
  ];

  it("applies seat defaults and resolves the paths dsh needs absolute", () => {
    const args = parseDshRunnerArgs(required);
    expect(args).toMatchObject({
      sessionName: SESSION, stateRoot: "/state/dsh", dshHome: "/state/dsh/h", cwd: "/repo",
      launchId: "launch-1", posture: "auto", profile: "acp", dshCommand: "dsh",
      runtimeLabel: "dsh", activity: true, resumeFallbackFresh: false, verbose: false, help: false,
    });
    expect(args.session).toBeNull();
  });

  it("refuses to guess a posture, a cwd, or a seat identity", () => {
    for (const flag of ["--session-name", "--state-root", "--dsh-home", "--cwd", "--launch-id", "--posture"]) {
      const argv = [...required];
      const at = argv.indexOf(flag);
      expect(at).toBeGreaterThanOrEqual(0);
      argv.splice(at, 2);
      expect(() => parseDshRunnerArgs(argv)).toThrow(/ is required$/);
    }
    // And the whole set really is required: nothing is silently defaulted.
    expect(() => parseDshRunnerArgs([])).toThrow(/--session-name is required/);
  });

  it("rejects an unknown posture instead of widening the sandbox", () => {
    const argv = [...required];
    argv[argv.indexOf("--posture") + 1] = "workspace-write";
    expect(() => parseDshRunnerArgs(argv)).toThrow(/unknown posture/);
  });

  it("rejects nonsense argv loudly", () => {
    expect(() => parseDshRunnerArgs([...required, "--wat"])).toThrow(/unknown argument "--wat"/);
    expect(() => parseDshRunnerArgs([...required, "--session-name"])).toThrow(/--session-name requires a value/);
    expect(() => parseDshRunnerArgs([...required, "--request-timeout", "-5"])).toThrow(/non-negative number/);
    expect(parseDshRunnerArgs([...required, "--request-timeout", "1500"]).requestTimeoutMs).toBe(1500);
  });

  it("accepts inline values and the boolean flags", () => {
    const args = parseDshRunnerArgs([...required, "--node-id=node-1", "--generation=gen-1", "--no-activity", "--verbose", "--resume-fallback-fresh"]);
    expect(args).toMatchObject({ nodeId: "node-1", generation: "gen-1", activity: false, verbose: true, resumeFallbackFresh: true });
    expect(parseDshRunnerArgs(["--help"]).help).toBe(true);
    // An inline value for a required flag is accepted too.
    expect(parseDshRunnerArgs(["--session-name=inline", ...required.slice(2)]).sessionName).toBe("inline");
  });
});

describe("permission posture", () => {
  const ask = [
    { optionId: "reject-once", kind: "reject_once" },
    { optionId: "reject-always", kind: "reject_always" },
    { optionId: "allow-once", kind: "allow_once" },
    { optionId: "allow-always", kind: "allow_always" },
  ];

  it("floor refuses escalation with dsh's own reject option", () => {
    expect(dshPermissionDecision(ask, "floor")).toEqual({ outcome: { outcome: "selected", optionId: "reject-once" } });
  });

  it("auto allows the single escalation", () => {
    expect(dshPermissionDecision(ask, "auto")).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
  });

  it("full_bypass prefers a standing allow", () => {
    expect(dshPermissionDecision(ask, "full_bypass")).toEqual({ outcome: { outcome: "selected", optionId: "allow-always" } });
  });

  it("answers cancelled rather than leaving the agent waiting on a human who is not there", () => {
    expect(dshPermissionDecision([{ optionId: "allow-once", kind: "allow_once" }], "floor")).toEqual({ outcome: { outcome: "cancelled" } });
    expect(dshPermissionDecision([], "auto")).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("labels the decision for the pane", () => {
    expect(describeDshPermission({ toolCall: { title: "Run a dangerous command" } })).toBe("Run a dangerous command");
    expect(describeDshPermission({ toolCall: { kind: "execute" } })).toBe("execute");
    expect(describeDshPermission({})).toBe("tool call");
    expect(describeDshDecision({ outcome: { outcome: "selected", optionId: "allow-once" } }, ask)).toBe("allow_once (allow-once)");
    expect(describeDshDecision({ outcome: { outcome: "cancelled" } }, ask)).toBe("cancelled (no matching option)");
  });
});

describe("runner core", () => {
  it("becomes READY, carries a prompt to the agent, and mirrors the answer", async () => {
    const f = makeCore();
    f.core.writePending();
    expect(f.sidecars.at(-1)).toMatchObject({ ready: false, launchId: "launch-77", exited: null });

    f.core.markReady({ sessionId: SESSION_ID });
    expect(f.lines).toContain(DSH_RUNNER_READY_MARKER);
    expect(f.sidecars.at(-1)).toMatchObject({ ready: true, sessionId: SESSION_ID, launchId: "launch-77" });
    // The seat's identity and activity are bound to the occupant generation.
    expect(f.activity.at(-1)).toEqual({
      hookEvent: "SessionStart", eventFamily: "session_identity", sessionId: SESSION_ID, sessionFile: null,
    });

    f.core.handleLine("say pong");
    await flush();
    expect(f.prompts).toEqual([{ sessionId: SESSION_ID, text: "say pong" }]);
    expect(f.activity.at(-1)).toMatchObject({ hookEvent: "UserPromptSubmit" });

    f.core.handleNotification("session/update", {
      sessionId: SESSION_ID,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "po" } },
    });
    f.core.handleNotification("session/update", {
      sessionId: SESSION_ID,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ng" } },
    });
    expect(f.appends.join("")).toBe("pong");

    f.finishTurn();
    await flush();
    expect(f.lines).toContain("── turn end (end_turn) ──");
    expect(f.activity.at(-1)).toMatchObject({ hookEvent: "Stop" });
  });

  it("queues prompts arriving mid-turn instead of dropping them (one prompt per session)", async () => {
    const f = makeCore();
    f.core.markReady({ sessionId: SESSION_ID });
    f.core.handleLine("first");
    f.core.handleLine("second");
    f.core.handleLine("third");
    await flush();
    expect(f.prompts).toHaveLength(1);
    expect(f.lines.some((line) => line.startsWith("[queued:"))).toBe(true);
    // Each queued line becomes its own turn, in order.
    for (const expected of ["second", "third"]) {
      f.finishTurn();
      await flush();
      expect(f.prompts.at(-1)?.text).toBe(expected);
    }
    expect(f.prompts.map((p) => p.text)).toEqual(["first", "second", "third"]);
  });

  it("answers an escalation from the seat's posture and refuses what it does not implement", () => {
    const f = makeCore(fakeIo(), fakeTransport(), { posture: "full_bypass" });
    const answered = f.core.handleRequest("session/request_permission", {
      toolCall: { title: "Run a dangerous command" },
      options: [{ optionId: "allow-always", kind: "allow_always" }, { optionId: "reject-once", kind: "reject_once" }],
    });
    expect(answered.decision).toEqual({ outcome: { outcome: "selected", optionId: "allow-always" } });
    expect(f.lines.at(-1)).toContain("[permission] Run a dangerous command → allow_always (allow-always) (posture full_bypass)");

    // An unknown agent request must be refused explicitly, or the agent wedges.
    const refused = f.core.handleRequest("session/something_new", {});
    expect(refused.refuse).toEqual({ code: -32601, message: "dsh-runner does not implement session/something_new" });
  });

  it("mirrors tool, thought and context updates", () => {
    const f = makeCore();
    f.core.markReady({ sessionId: SESSION_ID });
    const update = (body: Record<string, unknown>) =>
      f.core.handleNotification("session/update", { sessionId: SESSION_ID, update: body });

    update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "considering…" } });
    expect(f.thoughts.join("")).toBe("considering…");
    update({ sessionUpdate: "tool_call", title: "Read file", status: "pending" });
    expect(f.lines.at(-1)).toBe("[tool] Read file — pending");
    update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
    expect(f.lines.at(-1)).toBe("[tool] t1 — completed");
    update({ sessionUpdate: "usage_update", used: 250, size: 1000 });
    expect(f.lines.at(-1)).toBe("[context] 25% (250/1000)");
    // The same percentage is not repeated.
    const before = f.lines.length;
    update({ sessionUpdate: "usage_update", used: 251, size: 1000 });
    expect(f.lines.length).toBe(before);
    update({ sessionUpdate: "session_info_update", title: "Seat work" });
    expect(f.lines.at(-1)).toBe("[session] Seat work");
  });

  it("ignores updates addressed to another session and local commands the runner owns", () => {
    const f = makeCore();
    f.core.markReady({ sessionId: SESSION_ID });
    f.core.handleNotification("session/update", {
      sessionId: "session-other",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "not ours" } },
    });
    expect(f.appends).toEqual([]);

    f.core.handleLine("/session");
    expect(f.lines.at(-1)).toContain(`session ${SESSION_ID}`);
    f.core.handleLine("/usage");
    expect(f.lines.at(-1)).toContain("no usage reported yet");
    f.core.handleLine("/cancel");
    expect(f.cancels).toEqual([SESSION_ID]);
    expect(f.prompts).toEqual([]);
  });

  it("reports a dead agent honestly and never leaves a frozen pane", async () => {
    const f = makeCore();
    f.core.markReady({ sessionId: SESSION_ID });
    f.core.handleAgentExit({ code: 3, signal: null });
    await f.core.finished;
    expect(f.lines.some((line) => line.startsWith(DSH_RUNNER_ERROR_MARKER))).toBe(true);
    const final = f.sidecars.at(-1)!;
    expect(final.ready).toBe(false);
    expect(final.exited?.reason).toMatch(/agent-exit code=3/);
    expect(final.exited?.code).toBe(1);
    expect(f.core.result().code).toBe(1);
  });

  it("reports a failed turn instead of pretending it succeeded", async () => {
    const f = makeCore();
    f.core.markReady({ sessionId: SESSION_ID });
    f.core.handleLine("do the thing");
    await flush();
    f.failTurn("agent exploded");
    await flush();
    expect(f.lines.some((line) => line.includes("prompt failed: agent exploded"))).toBe(true);
    expect(f.activity.some((p) => p.hookEvent === "Notification" && p.subtype === "prompt_failed")).toBe(true);
    // The seat is still usable: the queue drains and readiness is unchanged.
    expect(f.core.isReady).toBe(true);
  });

  it("closes the session and records WHY the seat ended", async () => {
    const f = makeCore();
    f.core.markReady({ sessionId: SESSION_ID });
    await f.core.shutdown("user-quit");
    expect(f.closes).toEqual([SESSION_ID]);
    expect(f.disposals).toHaveLength(1);
    expect(f.lines).toContain(`${DSH_RUNNER_EXIT_MARKER} (user-quit)`);
    expect(f.sidecars.at(-1)).toMatchObject({ ready: false, exited: { reason: "user-quit" } });
    // The exit record is written exactly once.
    const writes = f.sidecars.length;
    await f.core.shutdown("stdin-closed");
    expect(f.sidecars.length).toBe(writes);
  });

  it("refuses a prompt before any session exists rather than losing it silently", () => {
    const f = makeCore(fakeIo(), fakeTransport());
    const core = new DshRunnerCore(f.io, {
      sessionName: SESSION, cwd: "/repo", launchId: "L", posture: "floor",
      permissionMode: "workspace-write", nodeId: null, generation: null, runtime: "dsh",
    });
    core.attachTransport(f.transport);
    core.handleLine("too early");
    expect(f.prompts).toEqual([]);
    expect(f.lines.at(-1)).toContain("no session yet");
  });

  it("refuses a paste-bomb line instead of accepting an unbounded prompt", () => {
    const f = makeCore();
    f.core.markReady({ sessionId: SESSION_ID });
    f.core.handleLine("x".repeat(MAX_DSH_INPUT_BYTES + 1));
    expect(f.prompts).toEqual([]);
    expect(f.lines.at(-1)).toContain("input line refused");
  });

  it("records a setup failure as the honest reason the seat never started", async () => {
    const f = makeCore();
    f.core.writePending();
    f.core.markSetupFailed({ error: "dsh: profile \"acp\" does not exist" });
    await f.core.finished;
    expect(f.lines.some((line) => line.includes("setup failed: dsh: profile"))).toBe(true);
    expect(f.sidecars.at(-1)).toMatchObject({ ready: false, exited: { reason: "setup-failed" } });
    expect(f.sidecars.at(-1)?.exited?.error).toMatch(/profile/);
    expect(f.core.result().code).toBe(1);
  });
});
