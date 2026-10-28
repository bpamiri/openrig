// OPR.0.6.DSH1 — hermetic tests for the dsh runner core and its argv contract.
// The core reaches the outside world only through DshRunnerIo, so every decision
// (readiness, the sidecar, one-prompt-in-flight queueing, permission answers,
// occupant-bound activity, honest death reporting) is testable with no dsh, no
// tmux and no model.

import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import {
  DshRunnerCore, MAX_DSH_INPUT_BYTES, createDshSignalHandler, describeDshDecision, describeDshPermission,
  dshPermissionDecision, parseDshRunnerArgs, runDshRunner,
  type DshActivityPoster, type DshActivityPayload, type DshRunnerArgs, type DshRunnerIo, type DshRunnerTransport,
} from "../src/adapters/dsh-runner.js";
import { createRunnerInput } from "../src/adapters/pi-runner.js";
import {
  DSH_RUNNER_ERROR_MARKER, DSH_RUNNER_EXIT_MARKER, DSH_RUNNER_READY_MARKER, type DshRunnerState,
} from "../src/adapters/dsh-runner-protocol.js";

const SESSION = "dev1-dsh@dsh-scratch";
const SESSION_ID = "fac46d5a-82c0-4687-b95d-b1c9dc0bfbc";

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
    expect(f.lines.at(-1)).toContain("session [redacted-session]");
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
    // N3: the agent's real code is preserved; a signal death (null) is 1.
    expect(final.exited?.code).toBe(3);
    expect(f.core.result().code).toBe(3);
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
    expect(f.lines.at(-1)).toContain("input refused");
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

// ── F10(b): runDshRunner setup wiring, with a fake ACP client ─────────────────

const ADVERTISED_MODEL = JSON.stringify(["deepseek-official", "deepseek-v4-flash"]);
const CONFIG_OPTIONS = [{
  id: "model",
  name: "Model",
  currentValue: ADVERTISED_MODEL,
  options: [{ name: "DeepSeek", options: [{ value: ADVERTISED_MODEL, name: "deepseek-v4-flash" }] }],
}, {
  id: "reasoning_effort",
  options: [{ value: "low", name: "low" }, { value: "high", name: "high" }],
}];

interface SetupEvent { kind: string }

class FakeAcpClient extends EventEmitter {
  events: SetupEvent[] = [];
  onEvent: ((kind: string) => void) | null = null;
  private note(kind: string): void { this.events.push({ kind }); this.onEvent?.(kind); }
  configs: Array<{ configId: string; value: string }> = [];
  timeouts: Array<{ method: string; timeoutMs: number | undefined }> = [];
  disposed = false;
  prompts: string[] = [];
  closes = 0;
  readonly failInitialize: string | null;
  readonly failConfig: string | null;
  readonly resumeError: string | null;
  readonly protocolVersion: number;
  readonly configOptions: unknown[] | undefined;
  readonly resumeConfigOptions: unknown[] | undefined;
  readonly exitOnDispose: { code: number | null; signal: string | null } | null;

  constructor(opts: {
    failInitialize?: string; failConfig?: string; resumeError?: string;
    protocolVersion?: number; configOptions?: unknown[] | undefined; resumeConfigOptions?: unknown[] | undefined;
    exitOnDispose?: { code: number | null; signal: string | null };
  } = {}) {
    super();
    this.failInitialize = opts.failInitialize ?? null;
    this.failConfig = opts.failConfig ?? null;
    this.resumeError = opts.resumeError ?? null;
    this.protocolVersion = opts.protocolVersion ?? 1;
    this.configOptions = "configOptions" in opts ? opts.configOptions : CONFIG_OPTIONS;
    this.resumeConfigOptions = opts.resumeConfigOptions;
    this.exitOnDispose = opts.exitOnDispose ?? null;
  }
  start(): void { this.note("start"); }
  async initialize(opts: { timeoutMs?: number } = {}): Promise<unknown> {
    this.note("initialize");
    this.timeouts.push({ method: "initialize", timeoutMs: opts.timeoutMs });
    if (this.failInitialize) throw new Error(this.failInitialize);
    return { protocolVersion: this.protocolVersion, agentCapabilities: { sessionCapabilities: { close: {}, resume: {}, list: {} } } };
  }
  async newSession(opts: { timeoutMs?: number } = {}): Promise<{ sessionId: string; configOptions?: unknown[] }> {
    this.note("newSession");
    this.timeouts.push({ method: "newSession", timeoutMs: opts.timeoutMs });
    return { sessionId: SESSION_ID, ...(this.configOptions ? { configOptions: this.configOptions } : {}) };
  }
  async resumeSession(opts: { timeoutMs?: number } = {}): Promise<{ sessionId: string; sessionIdReported: boolean; configOptions?: unknown[] }> {
    this.note("resumeSession");
    this.timeouts.push({ method: "resumeSession", timeoutMs: opts.timeoutMs });
    if (this.resumeError) throw new Error(this.resumeError);
    return {
      sessionId: SESSION_ID, sessionIdReported: false,
      ...(this.resumeConfigOptions ? { configOptions: this.resumeConfigOptions } : {}),
    };
  }
  async setConfigOption(opts: { configId: string; value: string; timeoutMs?: number }): Promise<unknown> {
    this.note(`config:${opts.configId}`);
    this.timeouts.push({ method: `config:${opts.configId}`, timeoutMs: opts.timeoutMs });
    if (this.failConfig) throw new Error(this.failConfig);
    this.configs.push({ configId: opts.configId, value: opts.value });
    return {};
  }
  async prompt(opts: { text: string }): Promise<{ stopReason: string }> {
    this.prompts.push(opts.text);
    return { stopReason: "end_turn" };
  }
  cancel(): void {}
  async closeSession(): Promise<unknown> { this.closes += 1; return {}; }
  async dispose(): Promise<void> {
    this.disposed = true;
    // A real child exits gracefully after dispose; N-C is about that exit
    // arriving after setup already decided the launch failed.
    if (this.exitOnDispose) this.emit("exit", this.exitOnDispose);
  }
}

function runSetup(opts: {
  extraArgs?: string[]; client?: FakeAcpClient; input?: Readable; fsReadFile?: (p: string) => string;
} = {}) {
  const client = opts.client ?? new FakeAcpClient();
  const writes: Array<{ kind: string; state?: DshRunnerState; order: number }> = [];
  const timeline: string[] = [];
  client.onEvent = (kind) => timeline.push(`client:${kind}`);
  const output = new PassThrough();
  let rendered = "";
  output.on("data", (chunk) => { rendered += chunk.toString(); });
  const fsOps = {
    readFile: (p: string) => opts.fsReadFile ? opts.fsReadFile(p) : "[]",
    writeFile: (p: string, content: string) => {
      let parsed: DshRunnerState | undefined;
      try { parsed = JSON.parse(content) as DshRunnerState; } catch { /* not a sidecar */ }
      timeline.push(`write-sidecar:${p.includes(".tmp") ? "tmp" : "final"}:ready=${String(parsed?.ready)}`);
      writes.push({ kind: p.includes(".tmp") ? "tmp" : "sidecar", order: timeline.length - 1, ...(parsed ? { state: parsed } : {}) });
    },
    mkdirp: () => {},
    rename: () => {},
  };
  const args: DshRunnerArgs = parseDshRunnerArgs([
    "--session-name", SESSION, "--state-root", "/state/dsh", "--dsh-home", "/state/dsh/h",
    "--cwd", "/repo", "--launch-id", "launch-1", "--posture", "floor",
    "--setup-timeout", "50",
    ...(opts.extraArgs ?? []),
  ], {});
  const run = runDshRunner({
    args, env: {}, input: opts.input ?? Readable.from([]), output: output as unknown as NodeJS.WriteStream,
    errorOutput: output as unknown as NodeJS.WriteStream,
    clientFactory: () => client as never,
    activityFactory: () => ({ enabled: false, turnStart() {}, turnEnd() {}, sessionIdentity() {}, attention() {} } as DshActivityPoster),
    fsOps, installSignalHandlers: false,
  });
  return { run, client, writes, timeline, rendered: () => rendered };
}

function sidecarStates(writes: Array<{ state?: DshRunnerState }>): DshRunnerState[] {
  return writes.flatMap((write) => write.state ? [write.state] : []);
}

describe("runDshRunner setup (F1/F3/F4/F11/F12/F13)", () => {
  it("maps the declared model to dsh's advertised selector and applies it BEFORE READY", async () => {
    const c = runSetup({ extraArgs: ["--model", "deepseek/deepseek-v4-flash", "--effort", "high"] });
    const result = await c.run;
    expect(result.code).toBe(0);
    expect(c.client.configs).toEqual([
      { configId: "model", value: ADVERTISED_MODEL },
      { configId: "reasoning_effort", value: "high" },
    ]);
    // F1: the raw provider/model string never reaches set_config_option.
    expect(c.client.configs.some((config) => config.value === "deepseek/deepseek-v4-flash")).toBe(false);
    // F3: the ready sidecar is written after the config calls, never before.
    const states = sidecarStates(c.writes);
    expect(states[0]).toMatchObject({ ready: false, launchId: "launch-1" });
    // The ready write happens only after the model config call.
    expect(c.timeline.indexOf("client:config:model")).toBeGreaterThan(-1);
    expect(c.timeline.indexOf("client:config:model")).toBeLessThan(c.timeline.findIndex((entry) => entry.includes("ready=true")));
    expect(states.some((state) => state.ready)).toBe(true);
    expect(c.rendered()).toContain(DSH_RUNNER_READY_MARKER);
    expect(c.rendered()).toContain("model: deepseek-v4-flash");
    // F11: the session id is stored in the sidecar (the token store), never
    // echoed into the captured pane.
    expect(c.rendered()).not.toContain(SESSION_ID);
  });

  it("uses the setup-scoped timeout for every setup request", async () => {
    const c = runSetup({ extraArgs: ["--model", "deepseek/deepseek-v4-flash", "--effort", "high"] });
    await c.run;
    expect(c.client.timeouts).toEqual([
      { method: "initialize", timeoutMs: 50 },
      { method: "newSession", timeoutMs: 50 },
      { method: "config:model", timeoutMs: 50 },
      { method: "config:reasoning_effort", timeoutMs: 50 },
    ]);
  });

  it("maps model/effort from the config options a RESUME reports", async () => {
    const c = runSetup({
      extraArgs: ["--session", SESSION_ID, "--model", "deepseek/deepseek-v4-flash"],
      client: new FakeAcpClient({ resumeConfigOptions: CONFIG_OPTIONS }),
    });
    const result = await c.run;
    expect(result.code).toBe(0);
    expect(c.client.configs).toEqual([{ configId: "model", value: ADVERTISED_MODEL }]);
    expect(c.client.events.map((event) => event.kind)).toContain("resumeSession");
  });

  it("fails before READY when a declared model is not advertised (the -32602 class)", async () => {
    const c = runSetup({ extraArgs: ["--model", "deepseek/deepseek-chat"] });
    const result = await c.run;
    expect(result.code).toBe(1);
    expect(c.rendered()).not.toContain(DSH_RUNNER_READY_MARKER);
    const states = sidecarStates(c.writes);
    expect(states.some((state) => state.ready)).toBe(false);
    expect(states.at(-1)?.exited).toMatchObject({ reason: "setup-failed" });
    expect(states.at(-1)?.exited?.error).toContain("not available");
    expect(states.at(-1)?.exited?.error).toContain("deepseek-v4-flash");
    expect(c.client.configs).toEqual([]);
    expect(c.client.disposed).toBe(true);
  });

  it("N-C: keeps exit 1 when a setup-failed launch's child exits 0 during dispose", async () => {
    const c = runSetup({
      extraArgs: ["--session", SESSION_ID],
      client: new FakeAcpClient({ resumeError: "session is not resumable", exitOnDispose: { code: 0, signal: null } }),
    });
    const result = await c.run;
    expect(result.code).toBe(1);
    expect(sidecarStates(c.writes).at(-1)?.exited).toMatchObject({ reason: "setup-failed" });
  });

  it("N-C: keeps exit 1 for an unmapped model whose child exits 0 during dispose", async () => {
    const c = runSetup({
      extraArgs: ["--model", "deepseek/deepseek-unknown"],
      client: new FakeAcpClient({ exitOnDispose: { code: 0, signal: null } }),
    });
    const result = await c.run;
    expect(result.code).toBe(1);
  });

  it("turns a rejected config option into setup-failed with no READY ever printed", async () => {
    const c = runSetup({ client: new FakeAcpClient({ failConfig: "model unavailable" }), extraArgs: ["--model", "deepseek/deepseek-v4-flash"] });
    const result = await c.run;
    expect(result.code).toBe(1);
    expect(c.rendered()).not.toContain(DSH_RUNNER_READY_MARKER);
    expect(sidecarStates(c.writes).some((state) => state.ready)).toBe(false);
    expect(sidecarStates(c.writes).at(-1)?.exited?.error).toContain("model unavailable");
  });

  it("turns a timed-out setup request into setup-failed with no READY", async () => {
    const c = runSetup({ client: new FakeAcpClient({ failInitialize: "initialize: timed out after 50ms" }) });
    const result = await c.run;
    expect(result.code).toBe(1);
    expect(c.rendered()).not.toContain(DSH_RUNNER_READY_MARKER);
    expect(sidecarStates(c.writes).at(-1)?.exited?.error).toContain("timed out");
    expect(c.client.disposed).toBe(true);
  });

  it("refuses a dsh with a different ACP protocol version", async () => {
    const c = runSetup({ client: new FakeAcpClient({ protocolVersion: 2 }) });
    const result = await c.run;
    expect(result.code).toBe(1);
    expect(sidecarStates(c.writes).at(-1)?.exited?.error).toMatch(/ACP protocol 2/);
  });

  it("records an unreadable --mcp-servers file as setup-failed instead of throwing out", async () => {
    const c = runSetup({
      extraArgs: ["--mcp-servers", "/missing.json"],
      fsReadFile: () => { throw new Error("ENOENT: /missing.json"); },
    });
    const result = await c.run;
    expect(result.code).toBe(1);
    expect(sidecarStates(c.writes).at(-1)?.exited?.error).toContain("ENOENT");
    expect(c.client.disposed).toBe(true);
  });

  it("scrubs the requested session id out of a resume refusal (F11)", async () => {
    const requested = "4f7b4d71-0fd8-4b73-a3db-893692e6375c";
    const c = runSetup({
      extraArgs: ["--session", requested],
      client: new FakeAcpClient({ resumeError: `session is not resumable: ${requested}` }),
    });
    const result = await c.run;
    expect(result.code).toBe(1);
    // The sidecar's sessionId is the token STORE (the adapter reads it); the
    // redaction contract is about error text, the pane and logs.
    const errorText = `${c.rendered()}|${sidecarStates(c.writes).map((state) => state.exited?.error ?? "").join("|")}`;
    expect(errorText).not.toContain(requested);
    expect(errorText).toContain("[redacted-session]");
  });

  it("delivers a pane line to dsh as one prompt, and /quit shuts down with a bounded close", async () => {
    const input = Readable.from(["hello\n/quit\n"]);
    const c = runSetup({ input });
    const result = await c.run;
    expect(result.code).toBe(0);
    expect(c.client.prompts).toEqual(["hello"]);
    expect(c.client.closes).toBe(1);
  });
});

describe("core lifecycle blockers (F2/F5)", () => {
  it("keeps a multi-line paste as ONE prompt (not one prompt per line)", () => {
    const f = fakeIo();
    const t = fakeTransport();
    const core = new DshRunnerCore(f.io, {
      sessionName: SESSION, cwd: "/repo", launchId: "L", posture: "floor",
      permissionMode: "workspace-write", nodeId: null, generation: null, runtime: "dsh",
    }, { sessionId: SESSION_ID });
    core.attachTransport(t.transport);
    core.handleInput("line one\nline two\nline three");
    expect(t.prompts).toHaveLength(1);
    expect(t.prompts[0]!.text).toBe("line one\nline two\nline three");
  });

  it("refuses an over-limit block with the byte count", () => {
    const f = fakeIo();
    const t = fakeTransport();
    const core = new DshRunnerCore(f.io, {
      sessionName: SESSION, cwd: "/repo", launchId: "L", posture: "floor",
      permissionMode: "workspace-write", nodeId: null, generation: null, runtime: "dsh",
    }, { sessionId: SESSION_ID, maxInputBytes: 4 });
    core.attachTransport(t.transport);
    core.handleInput("12345");
    expect(t.prompts).toEqual([]);
    expect(f.lines.join("\n")).toContain("input refused");
  });

  it("bounds a closeSession that never settles and still disposes + records the exit", async () => {
    const f = fakeIo();
    const t = fakeTransport();
    t.transport.closeSession = () => new Promise(() => {});
    const core = new DshRunnerCore(f.io, {
      sessionName: SESSION, cwd: "/repo", launchId: "L", posture: "floor",
      permissionMode: "workspace-write", nodeId: null, generation: null, runtime: "dsh",
    }, { sessionId: SESSION_ID, closeTimeoutMs: 20 });
    core.attachTransport(t.transport);
    const settled = await Promise.race([
      core.shutdown("user-quit").then(() => "shutdown"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 500)),
    ]);
    expect(settled).toBe("shutdown");
    expect(t.disposals).toHaveLength(1);
    expect(f.sidecars.at(-1)?.exited?.reason).toBe("user-quit");
  });

  it("escalates a second signal to a hard exit; the first asks the core to shut down", () => {
    const shutdown = vi.fn(async () => {});
    const exit = vi.fn();
    const handler = createDshSignalHandler({ shutdown } as never, { exit });
    handler("SIGTERM");
    expect(shutdown).toHaveBeenCalledWith("signal-SIGTERM");
    expect(exit).not.toHaveBeenCalled();
    handler("SIGTERM");
    expect(exit).toHaveBeenCalledWith(143);
    handler("SIGINT");
    expect(exit).toHaveBeenCalledWith(130);
  });
});

describe("pane input seam (F2)", () => {
  it("aggregates a bracketed paste into ONE block and enables raw mode", () => {
    const input = Object.assign(new PassThrough(), {
      isTTY: true, isRaw: false,
      setRawMode: vi.fn(function (this: { isRaw: boolean }, value: boolean) { this.isRaw = value; }),
    });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
    const blocks: string[] = [];
    const editor = createRunnerInput(input as unknown as NodeJS.ReadStream, output as unknown as NodeJS.WriteStream, (block) => blocks.push(block));
    try {
      input.write("\u001b[200~line one\nline two\nline three\u001b[201~\r");
      expect(blocks).toEqual(["line one\nline two\nline three"]);
      expect(input.setRawMode).toHaveBeenCalledWith(true);
    } finally {
      editor.close();
    }
    expect(input.isRaw).toBe(false);
  });

  it("N-B: Ctrl-C cancels through the dsh-local /abort, never as a model prompt", () => {
    const f = makeCore();
    const input = Object.assign(new PassThrough(), {
      isTTY: true, isRaw: false,
      setRawMode: vi.fn(function (this: { isRaw: boolean }, value: boolean) { this.isRaw = value; }),
    });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
    const editor = createRunnerInput(input as unknown as NodeJS.ReadStream, output as unknown as NodeJS.WriteStream,
      (block) => f.core.handleInput(block));
    try {
      input.write("\u0003");
    } finally {
      editor.close();
    }
    expect(f.cancels).toEqual([SESSION_ID]);
    expect(f.prompts).toEqual([]);
    expect(f.lines.join("\n")).toContain("cancel requested");
  });
});
