// OPR.0.6.DSH1 — the pane-hosted dsh runner.
//
// The adapter types `node <this file> …` into the seat's tmux pane; this process
// owns the ACP connection to `dsh --profile acp` and is therefore the only thing
// that makes a dsh seat a seat: OpenRig's `rig send` types into the pane, the
// pane's stdin reaches this runner, and the runner turns it into
// `session/prompt` calls. `rig capture` reads the mirrored transcript this
// runner prints back.
//
// Shape is deliberately the same as pi-runner.ts:
//   - `parseDshRunnerArgs` is the argv contract (pure, tested directly);
//   - `DshRunnerCore` holds every decision and reaches the outside world only
//     through `DshRunnerIo`, so its tests need no dsh, no tmux and no model;
//   - `main()` wires the real ACP client, the real filesystem and the real
//     stdin to that core;
//   - the file is import-safe: it only runs on direct invocation, so tests and
//     the adapter can import its types without spawning anything.
//
// The ACP client lives here (rather than a third module) because it is the one
// part that cannot be pure: it spawns a child and speaks NDJSON to it.

import nodePath from "node:path";
import nodeFs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import {
  DSH_DEFAULT_PROFILE, DSH_DEFAULT_SETUP_TIMEOUT_MS, DSH_RUNNER_ERROR_MARKER, DSH_RUNNER_EXIT_MARKER, DSH_RUNNER_READY_MARKER,
  buildDshChildArgs, buildDshChildEnv, dshPermissionModeForPosture, dshSeatPaths, normalizeDshPosture,
  parseDshRunnerState, redactDshSessionId, resolveDshConfigSelections,
  type DshConfigOption, type DshPermissionMode, type DshPosture, type DshRunnerExit, type DshRunnerState,
} from "./dsh-runner-protocol.js";
import { createRunnerInput } from "./pi-runner.js";

const DSH_RUNNER_VERSION = "0.1.0";
/** A pane is a terminal, not a pipe: a single unbounded block would be a
 *  paste-bomb. `tmux send-keys` never produces one; a human paste can. */
export const MAX_DSH_INPUT_BYTES = 1024 * 1024;
/** Setup-scoped bound for initialize/new/resume/set_config_option. It must stay
 *  BELOW the adapter's readiness window (30 s), so a wedged setup makes the
 *  runner write `exited: setup-failed` and exit instead of outliving the launch. */
export const DSH_SETUP_TIMEOUT_MS = DSH_DEFAULT_SETUP_TIMEOUT_MS;
/** Bound on the close handshake: a wedged dsh must not make `/quit` or a signal
 *  hang forever; after this the runner disposes the child unconditionally. */
export const DSH_CLOSE_TIMEOUT_MS = 2_000;

// ── ACP client ───────────────────────────────────────────────────────────────

export const ACP_PROTOCOL_VERSION = 1;

export class AcpError extends Error {
  readonly code: number | null;
  readonly data: unknown;
  readonly method: string | null;
  constructor(message: string, opts: { code?: number | null; data?: unknown; method?: string | null } = {}) {
    super(message);
    this.name = "AcpError";
    this.code = opts.code ?? null;
    this.data = opts.data ?? null;
    this.method = opts.method ?? null;
  }
}

/** A server→client request: answer it exactly once. */
export type AcpRespond = ((result: unknown) => void) & {
  error(code: number, message: string, data?: unknown): void;
};

export interface AcpClientEvents {
  notification: [{ method: string; params: Record<string, unknown> }];
  request: [{ method: string; params: Record<string, unknown>; respond: AcpRespond }];
  stdout: [{ line: string }];
  stderr: [{ line: string }];
  exit: [{ code: number | null; signal: string | null }];
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  timer: NodeJS.Timeout | undefined;
}

export interface AcpClientOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** 0 (the default) waits forever: a model turn can legitimately take minutes. */
  requestTimeoutMs?: number;
  /** Test seam: the family helper spawns a child; tests inject a fake one so the
   *  NDJSON framing is exercised without a real dsh. Defaults to `spawn`. */
  spawn?: typeof spawn;
}

export class AcpClient extends EventEmitter {
  private readonly options: AcpClientOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private stdoutReader: readline.Interface | null = null;
  private stderrReader: readline.Interface | null = null;
  private seq = 0;
  private closing = false;

  constructor(options: AcpClientOptions) {
    super();
    this.options = options;
  }

  get alive(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.closing;
  }

  start(): void {
    if (this.child) return;
    const spawnChild = this.options.spawn ?? spawn;
    const child = spawnChild(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    this.stdoutReader = readline.createInterface({ input: child.stdout });
    this.stdoutReader.on("line", (line) => this.onStdoutLine(line));
    this.stderrReader = readline.createInterface({ input: child.stderr });
    this.stderrReader.on("line", (line) => this.emit("stderr", { line }));

    child.on("error", (err) => this.failAll(new AcpError(`dsh failed to start: ${err.message}`)));
    child.on("exit", (code, signal) => {
      this.failAll(new AcpError(`dsh exited (code ${code ?? "unknown"} signal ${signal ?? "none"})`));
      this.emit("exit", { code, signal });
    });
  }

  /** ACP v1 over stdio is NDJSON — one JSON object per LF-terminated line, NOT
   *  LSP Content-Length framing. Anything that is not a frame is surfaced as
   *  stdout noise so it can never be mistaken for protocol. */
  private onStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      message = parsed as Record<string, unknown>;
    } catch {
      this.emit("stdout", { line: trimmed });
      return;
    }

    const id = typeof message["id"] === "number" ? message["id"] : undefined;
    const method = typeof message["method"] === "string" ? message["method"] : undefined;

    if (id !== undefined && method === undefined) {
      const entry = this.pending.get(id);
      if (!entry) {
        this.emit("stdout", { line: trimmed });
        return;
      }
      this.pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      const error = message["error"];
      if (error !== undefined && error !== null) {
        const shape = (typeof error === "object" ? error : {}) as Record<string, unknown>;
        entry.reject(new AcpError(
          typeof shape["message"] === "string" ? shape["message"] : "dsh returned an error",
          {
            code: typeof shape["code"] === "number" ? shape["code"] : null,
            data: shape["data"],
            method: entry.method,
          },
        ));
      } else {
        entry.resolve(message["result"]);
      }
      return;
    }

    if (method !== undefined && id !== undefined) {
      let answered = false;
      const respond = ((result: unknown) => {
        if (answered) return;
        answered = true;
        this.write({ jsonrpc: "2.0", id, result });
      }) as AcpRespond;
      respond.error = (code: number, message2: string, data?: unknown) => {
        if (answered) return;
        answered = true;
        this.write({ jsonrpc: "2.0", id, error: { code, message: message2, ...(data === undefined ? {} : { data }) } });
      };
      this.emit("request", { method, params: asRecord(message["params"]), respond });
      return;
    }

    if (method !== undefined) {
      this.emit("notification", { method, params: asRecord(message["params"]) });
      return;
    }

    this.emit("stdout", { line: trimmed });
  }

  request(method: string, params: Record<string, unknown>, opts: { timeoutMs?: number } = {}): Promise<unknown> {
    if (!this.child || this.closing) {
      return Promise.reject(new AcpError(`cannot send ${method}: dsh is not running`));
    }
    const id = ++this.seq;
    const timeoutMs = opts.timeoutMs ?? this.options.requestTimeoutMs ?? 0;
    return new Promise<unknown>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new AcpError(`${method}: timed out after ${timeoutMs}ms`, { method }));
        }, timeoutMs);
        timer.unref?.();
      }
      this.pending.set(id, { resolve, reject, method, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notification(method: string, params: Record<string, unknown>): void {
    if (!this.child || this.closing) return;
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: Record<string, unknown>): void {
    const child = this.child;
    if (!child || child.stdin.destroyed) return;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  // -- ACP v1 method wrappers ------------------------------------------------

  initialize(opts: { clientInfo?: { name: string; version: string }; timeoutMs?: number } = {}): Promise<unknown> {
    return this.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: opts.clientInfo ?? { name: "dsh-runner", version: DSH_RUNNER_VERSION },
    }, opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs });
  }

  newSession(opts: { cwd: string; mcpServers: unknown[]; timeoutMs?: number }): Promise<{ sessionId: string; configOptions?: DshConfigOption[] }> {
    return this.request("session/new", { cwd: opts.cwd, mcpServers: opts.mcpServers },
      opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs })
      .then((result) => {
        const record = asRecord(result);
        return { sessionId: asString(record["sessionId"]) ?? "", ...(configOptionsOf(record) ? { configOptions: configOptionsOf(record) } : {}) };
      });
  }

  /** dsh's `session/resume` result carries the config options, not a session id
   *  (verified on both 0.2.0-rc.2 and 0.2.1-rc.2). The requested id is the id
   *  the session keeps; success here is dsh's error-free acceptance, never a
   *  separate id report. */
  resumeSession(opts: { sessionId: string; cwd: string; mcpServers: unknown[]; timeoutMs?: number }): Promise<{ sessionId: string; sessionIdReported: boolean; configOptions?: DshConfigOption[] }> {
    // dsh refuses a resume whose cwd does not match the session's, and refuses a
    // session that is still active — an error here is the honest outcome.
    return this.request("session/resume", { sessionId: opts.sessionId, cwd: opts.cwd, mcpServers: opts.mcpServers },
      opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs })
      .then((result) => {
        const record = asRecord(result);
        const reported = asString(record["sessionId"]);
        return {
          sessionId: reported ?? opts.sessionId,
          sessionIdReported: reported !== undefined,
          ...(configOptionsOf(record) ? { configOptions: configOptionsOf(record) } : {}),
        };
      });
  }

  prompt(opts: { sessionId: string; text: string }): Promise<{ stopReason: string }> {
    return this.request("session/prompt", {
      sessionId: opts.sessionId,
      prompt: [{ type: "text", text: opts.text }],
    }).then((result) => ({ stopReason: asString(asRecord(result)["stopReason"]) ?? "unknown" }));
  }

  cancel(opts: { sessionId: string }): void {
    this.notification("session/cancel", { sessionId: opts.sessionId });
  }

  closeSession(opts: { sessionId: string; timeoutMs?: number }): Promise<unknown> {
    return this.request("session/close", { sessionId: opts.sessionId }, opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs });
  }

  setConfigOption(opts: { sessionId: string; configId: string; value: string; timeoutMs?: number }): Promise<unknown> {
    return this.request("session/set_config_option", {
      sessionId: opts.sessionId, configId: opts.configId, value: opts.value,
    }, opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs });
  }

  /** End stdin, wait for the child, then SIGKILL after a grace period. The
   *  timer is unref'd: a daemon-embedded runner must never hold the loop open. */
  async dispose(opts: { graceMs?: number } = {}): Promise<void> {
    const child = this.child;
    if (!child || this.closing) return;
    this.closing = true;
    const graceMs = opts.graceMs ?? 3000;
    if (child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, graceMs);
    timer.unref?.();
    child.stdin.end();
    await exited;
    clearTimeout(timer);
    this.stdoutReader?.close();
    this.stderrReader?.close();
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
/** dsh advertises `configOptions` on session/new and session/resume. Keep only
 *  objects with a string id; the pure resolver tolerates missing groups. */
function configOptionsOf(result: Record<string, unknown>): DshConfigOption[] | undefined {
  const raw = result["configOptions"];
  if (!Array.isArray(raw)) return undefined;
  const options = raw.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !Array.isArray(entry))
    .filter((entry) => typeof entry["id"] === "string")
    .map((entry) => entry as unknown as DshConfigOption);
  return options.length ? options : undefined;
}

// ── Runner argv contract ─────────────────────────────────────────────────────

export interface DshRunnerArgs {
  sessionName: string;
  stateRoot: string;
  dshHome: string;
  cwd: string;
  launchId: string;
  posture: DshPosture;
  profile: string;
  dshCommand: string;
  session: string | null;
  model: string | null;
  effort: string | null;
  mcpServersFile: string | null;
  runtimeLabel: string;
  nodeId: string | null;
  generation: string | null;
  requestTimeoutMs: number;
  /** Bound for the SETUP requests only; model turns stay at requestTimeoutMs. */
  setupTimeoutMs: number;
  activity: boolean;
  resumeFallbackFresh: boolean;
  verbose: boolean;
  help: boolean;
}

export const DSH_RUNNER_USAGE = `dsh-runner — host a DeepSeek Harness (dsh) ACP session in a tmux pane

  --session-name <name>     seat identity (required)
  --state-root <dir>        sidecar root (required)
  --dsh-home <dir>          writable DSH_HOME for the seat (required)
  --cwd <dir>              session working directory (required)
  --launch-id <id>          launch-attempt scope (required)
  --posture <p>             floor | auto | full_bypass (required)
  --session <id>            resume this dsh session id
  --model <id>              ACP model config option
  --effort <id>             ACP reasoning_effort config option
  --mcp-servers <file>      JSON file holding the ACP mcpServers array
  --profile <name>          dsh profile (default: ${DSH_DEFAULT_PROFILE})
  --dsh-command <cmd>       dsh executable (default: dsh)
  --runtime-label <label>   runtime name used in activity posts (default: dsh)
  --node-id <id>            OpenRig node id for activity posts
  --generation <id>         occupant generation for activity posts
  --request-timeout <ms>    ACP per-request timeout (default 0 = wait)
  --setup-timeout <ms>      bound for initialize/session/config requests (default ${DSH_SETUP_TIMEOUT_MS})
  --resume-fallback-fresh   start fresh when the resume is refused (default: fail loudly)
  --no-activity             do not post activity to the daemon
  --verbose                 print ignored protocol traffic
  -h, --help                this text
`;

const DSH_TAKES_VALUE = new Set([
  "--session-name", "--state-root", "--dsh-home", "--cwd", "--launch-id", "--posture",
  "--session", "--model", "--effort", "--mcp-servers", "--profile", "--dsh-command",
  "--runtime-label", "--node-id", "--generation", "--request-timeout", "--setup-timeout",
]);

/** Required flags are REQUIRED: a defaulted posture or cwd would be the adapter
 *  guessing on the operator's behalf, and this is the one boundary where a guess
 *  silently widens a seat's sandbox or points it at the wrong repository. */
export function parseDshRunnerArgs(argv: string[], env: Record<string, string | undefined> = process.env): DshRunnerArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--") && token !== "-h") throw new Error(`unknown argument "${token}"`);
    let flag = token;
    let inline: string | null = null;
    if (token.startsWith("--") && token.includes("=")) {
      const at = token.indexOf("=");
      flag = token.slice(0, at);
      inline = token.slice(at + 1);
    }
    if (flag === "-h" || flag === "--help") { help = true; continue; }
    if (flag === "--no-activity") { flags.add("no-activity"); continue; }
    if (flag === "--resume-fallback-fresh") { flags.add("resume-fallback-fresh"); continue; }
    if (flag === "--verbose") { flags.add("verbose"); continue; }
    if (!DSH_TAKES_VALUE.has(flag)) throw new Error(`unknown argument "${token}"`);
    let value: string;
    if (inline !== null) {
      value = inline;
    } else {
      index += 1;
      const next = argv[index];
      if (next === undefined) throw new Error(`${flag} requires a value`);
      value = next;
    }
    values.set(flag, value);
  }

  const required = (flag: string): string => {
    const value = values.get(flag);
    if (value === undefined || value.trim() === "") throw new Error(`${flag} is required`);
    return value;
  };

  // --help must work without a seat identity: validating the required flags
  // first would make `dsh-runner --help` fail with "… is required".
  if (help) {
    return {
      sessionName: "", stateRoot: "", dshHome: "", cwd: "", launchId: "", posture: "floor",
      profile: values.get("--profile") ?? DSH_DEFAULT_PROFILE,
      dshCommand: values.get("--dsh-command") ?? "dsh",
      session: null, model: null, effort: null, mcpServersFile: null,
      runtimeLabel: values.get("--runtime-label") ?? "dsh",
      nodeId: null, generation: null, requestTimeoutMs: 0, setupTimeoutMs: DSH_SETUP_TIMEOUT_MS,
      activity: true, resumeFallbackFresh: false, verbose: false, help: true,
    };
  }

  const rawTimeout = values.get("--request-timeout");
  let requestTimeoutMs = 0;
  if (rawTimeout !== undefined) {
    requestTimeoutMs = Number(rawTimeout);
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 0) {
      throw new Error("--request-timeout requires a non-negative number");
    }
  }
  const rawSetupTimeout = values.get("--setup-timeout");
  let setupTimeoutMs = DSH_SETUP_TIMEOUT_MS;
  if (rawSetupTimeout !== undefined) {
    setupTimeoutMs = Number(rawSetupTimeout);
    if (!Number.isFinite(setupTimeoutMs) || setupTimeoutMs <= 0) {
      throw new Error("--setup-timeout requires a positive number");
    }
  }

  return {
    sessionName: required("--session-name"),
    stateRoot: nodePath.resolve(required("--state-root")),
    dshHome: nodePath.resolve(required("--dsh-home")),
    cwd: nodePath.resolve(required("--cwd")),
    launchId: required("--launch-id"),
    // normalizeDshPosture throws on an unknown value rather than defaulting.
    posture: normalizeDshPosture(required("--posture")),
    profile: values.get("--profile") ?? DSH_DEFAULT_PROFILE,
    dshCommand: values.get("--dsh-command") ?? "dsh",
    session: values.get("--session") ?? null,
    model: values.get("--model") ?? null,
    effort: values.get("--effort") ?? null,
    mcpServersFile: values.get("--mcp-servers") ?? null,
    runtimeLabel: values.get("--runtime-label") ?? "dsh",
    nodeId: values.get("--node-id") ?? null,
    generation: values.get("--generation") ?? null,
    requestTimeoutMs,
    setupTimeoutMs,
    activity: !flags.has("no-activity"),
    resumeFallbackFresh: flags.has("resume-fallback-fresh"),
    verbose: flags.has("verbose"),
    help,
  };
}

// ── Activity posting ─────────────────────────────────────────────────────────

export interface DshActivityPayload {
  hookEvent: string;
  subtype?: string | null;
  eventFamily?: string;
  sessionId?: string;
  sessionFile?: string | null;
  [key: string]: unknown;
}

export interface DshActivityPoster {
  readonly enabled: boolean;
  turnStart(): void;
  turnEnd(): void;
  sessionIdentity(opts: { sessionId: string; sessionFile?: string | null }): void;
  attention(reason: string): void;
}

export interface DshActivityOptions {
  sessionName: string;
  nodeId: string | null;
  generation: string | null;
  runtime: string;
  endpoint: { baseUrl: string; token: string } | null;
  fetchImpl?: typeof globalThis.fetch;
  onError?: (error: Error) => void;
  disabled?: boolean;
}

/** Fire-and-forget: a daemon outage must never disturb the seat loop. Every
 *  payload carries nodeId AND generation, which is what makes the daemon's
 *  occupant-tenure gate trust the post instead of falling back to window
 *  sampling (issue #29 on Pi was exactly this omission). */
export class HttpDshActivityPoster implements DshActivityPoster {
  private readonly options: DshActivityOptions;
  private readonly fetchImpl: typeof globalThis.fetch | undefined;
  private readonly onError: (error: Error) => void;

  constructor(options: DshActivityOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? (typeof fetch === "function" ? fetch : undefined);
    this.onError = options.onError ?? (() => {});
  }

  get enabled(): boolean {
    return !this.options.disabled && this.options.endpoint !== null && this.fetchImpl !== undefined;
  }

  turnStart(): void { this.send({ hookEvent: "UserPromptSubmit", subtype: null }); }
  turnEnd(): void { this.send({ hookEvent: "Stop", subtype: null }); }

  sessionIdentity(opts: { sessionId: string; sessionFile?: string | null }): void {
    this.send({
      eventFamily: "session_identity",
      hookEvent: "SessionStart",
      sessionId: opts.sessionId,
      sessionFile: opts.sessionFile ?? null,
    });
  }

  /** An escalation the runner refused, or an agent failure, is exactly what a
   *  human needs to see — Phase 1 defined this hook and never called it. */
  attention(reason: string): void {
    this.send({ hookEvent: "Notification", subtype: reason });
  }

  private send(body: DshActivityPayload): void {
    const endpoint = this.options.endpoint;
    const fetchImpl = this.fetchImpl;
    if (!this.enabled || !endpoint || !fetchImpl) return;
    const payload = {
      sessionName: this.options.sessionName,
      nodeId: this.options.nodeId,
      generation: this.options.generation,
      runtime: this.options.runtime,
      occurredAt: new Date().toISOString(),
      ...body,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    timer.unref?.();
    Promise.resolve(fetchImpl(new URL("/api/activity/hooks", endpoint.baseUrl).toString(), {
      method: "POST",
      headers: { "content-type": "application/json", "x-openrig-activity-token": endpoint.token },
      body: JSON.stringify(payload),
      signal: controller.signal,
    }))
      .catch((err: unknown) => this.onError(err instanceof Error ? err : new Error(String(err))))
      .finally(() => clearTimeout(timer));
  }
}

export function defaultOpenRigHome(env: Record<string, string | undefined> = process.env): string {
  const home = env["OPENRIG_HOME"];
  if (home && home.trim()) return home;
  const userHome = env["HOME"] ?? "";
  return nodePath.join(userHome, ".openrig");
}

export function readDshActivityEndpoint(openrigHome: string): { baseUrl: string; token: string } | null {
  try {
    const raw = nodeFs.readFileSync(nodePath.join(openrigHome, "activity-endpoint.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const record = asRecord(parsed);
    const baseUrl = record["baseUrl"];
    const token = record["token"];
    if (typeof baseUrl === "string" && baseUrl.trim() && typeof token === "string" && token.trim()) {
      return { baseUrl, token };
    }
    return null;
  } catch {
    return null;
  }
}

// ── The runner core (all decisions; the outside world only via DshRunnerIo) ──

export interface DshRunnerIo {
  /** Stream a chunk of assistant text (no trailing newline). */
  mirrorAppend(text: string): void;
  /** Stream a chunk of the agent's thinking, visually distinct. */
  mirrorThought(text: string): void;
  /** A whole runner-authored line. */
  mirrorLine(line: string): void;
  postActivity(payload: DshActivityPayload): void;
  writeSidecar(state: DshRunnerState): void;
  now(): string;
}

export interface DshRunnerIdentity {
  sessionName: string;
  cwd: string;
  launchId: string;
  posture: DshPosture;
  permissionMode: DshPermissionMode;
  nodeId: string | null;
  generation: string | null;
  runtime: string;
}

export interface DshRunnerResult {
  code: number;
  sessionId: string | null;
  exitReason: string | null;
}

export function describeDshPermission(
  params: Record<string, unknown>,
): string {
  const toolCall = asRecord(params["toolCall"]);
  return asString(toolCall["title"]) ?? asString(toolCall["kind"]) ?? asString(toolCall["toolCallId"]) ?? "tool call";
}

export interface DshPermissionOption {
  optionId: string;
  kind: string;
}

export type DshPermissionDecision = { outcome: { outcome: "selected"; optionId: string } } | { outcome: { outcome: "cancelled" } };

/** The posture decides what happens when dsh asks to escalate:
 *   floor       — refuse, using dsh's own reject option (DSH_PERMISSION_MODE
 *                 already confined the agent to the workspace);
 *   auto        — allow once;
 *   full_bypass — allow, preferring a standing allow so the human is not asked
 *                 again for the same class of action.
 *  When no option matches the posture the answer is `cancelled`, never silence:
 *  an agent waiting on a human who is not in the pane must be released. */
export function dshPermissionDecision(
  options: readonly DshPermissionOption[],
  posture: DshPosture,
): DshPermissionDecision {
  const pick = (...kinds: string[]): DshPermissionOption | undefined =>
    kinds.map((kind) => options.find((option) => option.kind === kind)).find((option) => option !== undefined);
  const selected = (option: DshPermissionOption): DshPermissionDecision =>
    ({ outcome: { outcome: "selected", optionId: option.optionId } });
  const cancelled: DshPermissionDecision = { outcome: { outcome: "cancelled" } };

  if (posture === "floor") {
    const option = pick("reject_once", "reject_always");
    return option ? selected(option) : cancelled;
  }
  if (posture === "auto") {
    const option = pick("allow_once", "allow_always");
    return option ? selected(option) : cancelled;
  }
  const option = pick("allow_always", "allow_once");
  return option ? selected(option) : cancelled;
}

export function describeDshDecision(
  decision: DshPermissionDecision,
  options: readonly DshPermissionOption[],
): string {
  if (decision.outcome.outcome === "cancelled") return "cancelled (no matching option)";
  const optionId = decision.outcome.optionId;
  const chosen = options.find((candidate) => candidate.optionId === optionId);
  return chosen ? `${chosen.kind} (${chosen.optionId})` : optionId;
}

interface QueuedPrompt { text: string }

export class DshRunnerCore {
  private readonly io: DshRunnerIo;
  private readonly identity: DshRunnerIdentity;
  private readonly maxInputBytes: number;
  private sessionId: string | null;
  private ready = false;
  private shuttingDown = false;
  private exitReason: string | null = null;
  private exitCode = 0;
  private exitAnnounced = false;
  private lastUsagePercent: number | null = null;
  private readonly queue: QueuedPrompt[] = [];
  private inFlight = false;
  private resolveDone: (() => void) | null = null;
  private readonly done = new Promise<void>((resolve) => { this.resolveDone = resolve; });

  private readonly closeTimeoutMs: number;

  constructor(io: DshRunnerIo, identity: DshRunnerIdentity, opts: { sessionId?: string | null; maxInputBytes?: number; closeTimeoutMs?: number } = {}) {
    this.io = io;
    this.identity = identity;
    this.sessionId = opts.sessionId ?? null;
    this.maxInputBytes = opts.maxInputBytes ?? MAX_DSH_INPUT_BYTES;
    this.closeTimeoutMs = opts.closeTimeoutMs ?? DSH_CLOSE_TIMEOUT_MS;
  }

  /** Everything the core needs from the transport, in one place. Kept as a
   *  narrow surface so the tests can drive a seat with no dsh and no model. */
  private transport: DshRunnerTransport | null = null;

  attachTransport(transport: DshRunnerTransport): void {
    this.transport = transport;
  }

  get currentSessionId(): string | null { return this.sessionId; }
  get isReady(): boolean { return this.ready; }
  get isShuttingDown(): boolean { return this.shuttingDown; }
  get pending(): number { return this.queue.length + (this.inFlight ? 1 : 0); }
  get finished(): Promise<void> { return this.done; }

  private writeState(patch: Partial<DshRunnerState> = {}): void {
    this.io.writeSidecar({
      ready: this.ready,
      launchId: this.identity.launchId,
      sessionName: this.identity.sessionName,
      cwd: this.identity.cwd,
      posture: this.identity.posture,
      permissionMode: this.identity.permissionMode,
      sessionId: this.sessionId,
      updatedAt: this.io.now(),
      exited: null,
      ...patch,
    });
  }

  /** The pre-spawn pending record. Written by the ADAPTER before it types
   *  anything, and by the runner as its first sidecar write, so a poll that
   *  starts before the process even exists sees this attempt's launchId. */
  writePending(): void {
    this.writeState({ ready: false, exited: null });
  }

  banner(lines: { profile: string; dshHome: string; activityEnabled: boolean; activityRequested: boolean }): void {
    this.io.mirrorLine(`[dsh-runner] ${this.identity.sessionName} · cwd ${this.identity.cwd} · profile ${lines.profile}`);
    this.io.mirrorLine(`[dsh-runner] DSH_HOME ${lines.dshHome} · posture ${this.identity.posture} · DSH_PERMISSION_MODE ${this.identity.permissionMode}`);
    this.io.mirrorLine(`[dsh-runner] launch ${this.identity.launchId}${lines.activityEnabled ? "" : " · activity reporting off"}`);
    if (!lines.activityRequested) this.io.mirrorLine("[dsh-runner] activity reporting disabled by flag");
    else if (!lines.activityEnabled) this.io.mirrorLine("[dsh-runner] activity reporting off (no OpenRig activity endpoint found)");
  }

  /** Hand the established session to the core. The session id comes from the
   *  AGENT's own session/new or session/resume result, never from us. */
  markReady(opts: { sessionId: string }): void {
    this.sessionId = opts.sessionId;
    this.ready = true;
    this.writeState({ ready: true, exited: null });
    this.io.postActivity({ hookEvent: "SessionStart", eventFamily: "session_identity", sessionId: opts.sessionId, sessionFile: null });
    this.io.mirrorLine(DSH_RUNNER_READY_MARKER);
    this.io.mirrorLine("[dsh-runner] type a line + Enter to prompt · /help for local commands");
  }

  markSetupFailed(opts: { error: string }): void {
    this.ready = false;
    this.exitCode = 1;
    this.exitReason = "setup-failed";
    this.exitAnnounced = true;
    this.io.mirrorLine(`${DSH_RUNNER_ERROR_MARKER} setup failed: ${opts.error}`);
    this.writeState({ ready: false, exited: { reason: "setup-failed", error: opts.error } });
    this.resolveDone?.();
  }

  // -- input ----------------------------------------------------------------

  /** One pane input block. The pane input helper (the Pi-family
   *  `createRunnerInput`) submits a single line, or a whole paste as ONE block,
   *  so a multi-line message stays one prompt. Local commands are the runner's;
   *  everything else is work. A block with no newline for a very long time is a
   *  paste bomb, not a prompt. */
  handleInput(rawBlock: string): void {
    if (this.shuttingDown) return;
    const block = rawBlock.replace(/\r$/, "");
    const bytes = Buffer.byteLength(block);
    if (bytes > this.maxInputBytes) {
      this.io.mirrorLine(`${DSH_RUNNER_ERROR_MARKER} input refused: ${bytes} bytes exceeds the ${this.maxInputBytes}-byte limit`);
      return;
    }
    if (!block.trim()) return;
    const singleLine = !block.includes("\n") && !block.includes("\r");
    if (singleLine && block.trim().startsWith("/") && this.handleLocalCommand(block.trim())) return;
    this.enqueue(block);
  }

  /** Back-compat for callers/tests that hand the core one line. */
  handleLine(rawLine: string): void {
    this.handleInput(rawLine);
  }

  handleInputClosed(): void {
    if (!this.shuttingDown) void this.shutdown("stdin-closed");
  }

  private handleLocalCommand(line: string): boolean {
    const [verb] = line.slice(1).split(/\s+/);
    switch (verb) {
      case "help":
        this.io.mirrorLine("local: /help /session /usage /cancel /abort /quit — anything else is sent to the agent");
        return true;
      case "session":
        this.io.mirrorLine(`[dsh-runner] session ${this.sessionId ? "[redacted-session]" : "(none)"} · cwd ${this.identity.cwd}`);
        return true;
      case "usage":
        this.io.mirrorLine(this.lastUsagePercent === null
          ? "[dsh-runner] no usage reported yet"
          : `[dsh-runner] context ${this.lastUsagePercent}% used`);
        return true;
      case "cancel":
      case "abort":
        // N-B: the Pi-family input helper submits "/abort" on Ctrl-C; for dsh
        // that must cancel the turn, never become a model prompt.
        if (this.sessionId) {
          this.transport?.cancel(this.sessionId);
          this.io.mirrorLine("[dsh-runner] cancel requested");
        }
        return true;
      case "quit":
      case "exit":
        this.io.mirrorLine("[dsh-runner] closing");
        void this.shutdown("user-quit");
        return true;
      default:
        return false;
    }
  }

  // -- turns ----------------------------------------------------------------

  private enqueue(text: string): void {
    if (!this.sessionId) {
      this.io.mirrorLine(`${DSH_RUNNER_ERROR_MARKER} no session yet — the prompt was not sent`);
      return;
    }
    this.queue.push({ text });
    if (this.inFlight || this.queue.length > 1) {
      this.io.mirrorLine(`[queued: ${this.queue.length}${this.inFlight ? " · 1 running" : ""}]`);
    }
    this.pump();
  }

  /** ACP allows exactly one prompt per session, so pane input queues. */
  private pump(): void {
    if (this.inFlight || this.shuttingDown || this.queue.length === 0) return;
    const transport = this.transport;
    const sessionId = this.sessionId;
    const next = this.queue.shift();
    if (!transport || !sessionId || !next) return;
    this.inFlight = true;
    this.io.postActivity({ hookEvent: "UserPromptSubmit", subtype: null });
    transport.prompt({ sessionId, text: next.text })
      .then((result) => {
        this.io.mirrorLine(`── turn end (${result.stopReason}) ──`);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (!this.shuttingDown) {
          this.io.mirrorLine(`${DSH_RUNNER_ERROR_MARKER} prompt failed: ${message}`);
          this.io.postActivity({ hookEvent: "Notification", subtype: "prompt_failed" });
        }
      })
      .finally(() => {
        this.inFlight = false;
        this.io.postActivity({ hookEvent: "Stop", subtype: null });
        this.pump();
      });
  }

  // -- protocol events -------------------------------------------------------

  handleNotification(method: string, params: Record<string, unknown>): void {
    if (this.shuttingDown) return;
    if (method !== "session/update") return;
    const sessionId = asString(params["sessionId"]);
    if (sessionId && sessionId !== this.sessionId) return;
    this.handleSessionUpdate(asRecord(params["update"]));
  }

  private handleSessionUpdate(update: Record<string, unknown>): void {
    const kind = asString(update["sessionUpdate"]);
    switch (kind) {
      case "agent_message_chunk": {
        const content = asRecord(update["content"]);
        if (content["type"] === "text") this.io.mirrorAppend(asString(content["text"]) ?? "");
        break;
      }
      case "agent_thought_chunk": {
        const content = asRecord(update["content"]);
        if (content["type"] === "text") this.io.mirrorThought(asString(content["text"]) ?? "");
        break;
      }
      case "tool_call":
        this.io.mirrorLine(`[tool] ${asString(update["title"]) ?? asString(update["kind"]) ?? asString(update["toolCallId"]) ?? "call"}${asString(update["status"]) ? ` — ${asString(update["status"])}` : ""}`);
        break;
      case "tool_call_update": {
        const label = asString(update["title"]) ?? asString(update["toolCallId"]) ?? "call";
        if (asString(update["status"])) this.io.mirrorLine(`[tool] ${label} — ${asString(update["status"])}`);
        break;
      }
      case "usage_update": {
        const used = update["used"];
        const size = update["size"];
        if (typeof used === "number" && typeof size === "number" && size > 0) {
          const percent = Math.floor((used / size) * 100);
          if (percent !== this.lastUsagePercent) {
            this.lastUsagePercent = percent;
            this.io.mirrorLine(`[context] ${percent}% (${used}/${size})`);
          }
        }
        break;
      }
      case "session_info_update":
        if (asString(update["title"])) this.io.mirrorLine(`[session] ${asString(update["title"])}`);
        break;
      default:
        break;
    }
  }

  /** Returns the decision so the caller can answer the agent. An unknown agent
   *  request must be refused explicitly: a request left unanswered wedges the
   *  agent with no way for the pane to release it. */
  handleRequest(method: string, params: Record<string, unknown>): { decision?: DshPermissionDecision; refuse?: { code: number; message: string } } {
    if (method !== "session/request_permission") {
      return { refuse: { code: -32601, message: `dsh-runner does not implement ${method}` } };
    }
    const options = readPermissionOptions(params["options"]);
    const decision = dshPermissionDecision(options, this.identity.posture);
    this.io.mirrorLine(`[permission] ${describeDshPermission(params)} → ${describeDshDecision(decision, options)} (posture ${this.identity.posture})`);
    if (decision.outcome.outcome === "cancelled") {
      this.io.postActivity({ hookEvent: "Notification", subtype: "permission_unanswerable" });
    }
    return { decision };
  }

  // -- lifecycle -------------------------------------------------------------

  handleAgentExit(opts: { code: number | null; signal: string | null }): void {
    // N-C: setup failure / shutdown already decided the exit record. A graceful
    // child exit during dispose must not overwrite it (a setup-failed launch
    // exiting 0 looked successful to the caller).
    if (this.exitAnnounced) return;
    this.ready = false;
    if (!this.shuttingDown) {
      // A child that dies on its own is an agent failure, not a seat shutdown:
      // say so rather than leaving a pane that looks alive.
      this.exitReason = `agent-exit code=${opts.code} signal=${opts.signal}`;
      // N3: keep the agent's real code; a null code (signal death) still reads
      // as a seat failure, and the reason string always carries the signal.
      this.exitCode = opts.code === null ? 1 : opts.code;
    }
    this.finish();
  }

  async shutdown(reason: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.exitReason = reason;
    this.io.mirrorLine(`[dsh-runner] shutting down (${reason})`);
    const transport = this.transport;
    const sessionId = this.sessionId;
    if (transport && sessionId) {
      // Bounded: a wedged closeSession must not make /quit or a signal hang.
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.resolve(transport.closeSession(sessionId)).catch(() => { /* the agent may already be gone */ }),
          new Promise<void>((resolve) => { timer = setTimeout(resolve, this.closeTimeoutMs); timer.unref?.(); }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    try { await transport?.dispose(); } catch { /* idempotent */ }
    this.finish();
  }

  /** Idempotent: the sidecar's exit record is written exactly once. */
  private finish(): void {
    if (!this.exitAnnounced) {
      this.exitAnnounced = true;
      const marker = this.exitReason?.startsWith("agent-exit") && this.exitCode !== 0
        ? DSH_RUNNER_ERROR_MARKER
        : DSH_RUNNER_EXIT_MARKER;
      this.ready = false;
      const exited: DshRunnerExit = { reason: this.exitReason ?? "unknown" };
      if (this.exitCode !== 0) exited.code = this.exitCode;
      this.io.writeSidecar({
        ready: false,
        launchId: this.identity.launchId,
        sessionName: this.identity.sessionName,
        cwd: this.identity.cwd,
        posture: this.identity.posture,
        permissionMode: this.identity.permissionMode,
        sessionId: this.sessionId,
        updatedAt: this.io.now(),
        exited,
      });
      this.io.mirrorLine(`${marker} (${exited.reason})`);
    }
    this.resolveDone?.();
  }

  result(): DshRunnerResult {
    return { code: this.exitCode, sessionId: this.sessionId, exitReason: this.exitReason };
  }
}

/** F5: the first signal asks the core to shut down (bounded); a second signal
 *  escalates to a hard exit so a wedged dsh cannot trap the seat. */
export function createDshSignalHandler(
  core: Pick<DshRunnerCore, "shutdown">,
  opts: { exit?: (code: number) => void } = {},
): (signal: NodeJS.Signals) => void {
  let signals = 0;
  const exit = opts.exit ?? ((code: number) => { process.exit(code); });
  return (signal) => {
    signals += 1;
    if (signals > 1) {
      exit(signal === "SIGINT" ? 130 : 143);
      return;
    }
    void core.shutdown(`signal-${signal}`);
  };
}

/** F13: refuse a dsh that speaks a different ACP version or lacks the session
 *  capabilities this runner actually uses. */
function assertDshAcpSurface(result: unknown): void {
  const record = asRecord(result);
  const version = record["protocolVersion"];
  if (version !== ACP_PROTOCOL_VERSION) {
    throw new Error(`dsh speaks ACP protocol ${String(version)}; OpenRig requires ${ACP_PROTOCOL_VERSION}`);
  }
  const capabilities = asRecord(asRecord(record["agentCapabilities"])["sessionCapabilities"]);
  const missing = ["close", "resume"].filter((name) => capabilities[name] === undefined);
  if (missing.length > 0) {
    throw new Error(`dsh does not advertise the ACP session capabilities OpenRig needs: ${missing.join(", ")}`);
  }
}

/** The transport the core drives. `AcpClient` satisfies it structurally. */
export interface DshRunnerTransport {
  prompt(opts: { sessionId: string; text: string }): Promise<{ stopReason: string }>;
  cancel(sessionId: string): void;
  closeSession(sessionId: string): Promise<unknown>;
  dispose(opts?: { graceMs?: number }): Promise<void>;
}

function readPermissionOptions(raw: unknown): DshPermissionOption[] {
  if (!Array.isArray(raw)) return [];
  const options: DshPermissionOption[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    const optionId = asString(record["optionId"]);
    const kind = asString(record["kind"]);
    if (optionId && kind) options.push({ optionId, kind });
  }
  return options;
}

// ── Real-process wiring ──────────────────────────────────────────────────────

export interface RunDshRunnerOptions {
  args: DshRunnerArgs;
  env?: Record<string, string | undefined>;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  errorOutput?: NodeJS.WriteStream;
  clientFactory?: (options: AcpClientOptions) => AcpClient;
  activityFactory?: (options: DshActivityOptions) => DshActivityPoster;
  fsOps?: {
    readFile(path: string): string;
    writeFile(path: string, content: string): void;
    mkdirp(path: string): void;
    rename(from: string, to: string): void;
  };
  now?: () => string;
  /** Only the direct-invocation path installs signal handlers. */
  installSignalHandlers?: boolean;
}

export async function runDshRunner(options: RunDshRunnerOptions): Promise<DshRunnerResult> {
  const {
    args,
    env = process.env,
    input = process.stdin,
    output = process.stdout,
    errorOutput = process.stderr,
    clientFactory = (opts) => new AcpClient(opts),
    activityFactory = (opts) => new HttpDshActivityPoster(opts),
    now = () => new Date().toISOString(),
    installSignalHandlers = false,
  } = options;

  const fsOps = options.fsOps ?? defaultFsOps;
  const paths = dshSeatPaths(args.stateRoot, args.sessionName);
  const posture = args.posture;
  const permissionMode = dshPermissionModeForPosture(posture);

  const activity = activityFactory({
    sessionName: args.sessionName,
    nodeId: args.nodeId,
    generation: args.generation,
    runtime: args.runtimeLabel,
    endpoint: args.activity ? readDshActivityEndpoint(defaultOpenRigHome(env)) : null,
    disabled: !args.activity,
    onError: (err) => { if (args.verbose) errorOutput.write(`[dsh-runner] activity post failed: ${err.message}\n`); },
  });

  let midLine = false;
  const io: DshRunnerIo = {
    mirrorAppend: (text) => { output.write(text); midLine = text.length > 0; },
    mirrorThought: (text) => { output.write(`\u001b[2m· ${text}\u001b[0m`); midLine = text.length > 0; },
    // Never emit a runner-authored line mid-chunk: the adapter greps for markers
    // at line starts, so streamed assistant text must be closed first.
    mirrorLine: (line) => {
      output.write(`${midLine ? "\n" : ""}${line}\n`);
      midLine = false;
    },
    postActivity: (payload) => {
      // One place maps the core's payload intent onto the poster, so the core
      // never needs to know whether activity is enabled or where it goes.
      if (payload.eventFamily === "session_identity" && typeof payload.sessionId === "string") {
        activity.sessionIdentity({ sessionId: payload.sessionId, sessionFile: payload.sessionFile ?? null });
        return;
      }
      switch (payload.hookEvent) {
        case "UserPromptSubmit": activity.turnStart(); break;
        case "Stop": activity.turnEnd(); break;
        case "Notification": activity.attention(typeof payload.subtype === "string" ? payload.subtype : "attention"); break;
        default: break;
      }
    },
    writeSidecar: (state) => {
      try {
        fsOps.mkdirp(nodePath.dirname(paths.runnerStatePath));
        const tmp = `${paths.runnerStatePath}.tmp.${process.pid}`;
        fsOps.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
        fsOps.rename(tmp, paths.runnerStatePath);
      } catch {
        // Best effort: the adapter falls back to the pane's READY marker.
      }
    },
    now,
  };

  const core = new DshRunnerCore(io, {
    sessionName: args.sessionName,
    cwd: args.cwd,
    launchId: args.launchId,
    posture,
    permissionMode,
    nodeId: args.nodeId,
    generation: args.generation,
    runtime: args.runtimeLabel,
  }, { sessionId: args.session });

  const client = clientFactory({
    command: args.dshCommand,
    args: buildDshChildArgs({ profile: args.profile }),
    cwd: args.cwd,
    env: buildDshChildEnv(env, {
      dshHome: args.dshHome,
      permissionMode,
      model: args.model ?? undefined,
      sessionName: args.sessionName,
      nodeId: args.nodeId ?? undefined,
      generation: args.generation ?? undefined,
    }),
    requestTimeoutMs: args.requestTimeoutMs,
  });

  core.attachTransport({
    prompt: (opts) => client.prompt(opts),
    cancel: (sessionId) => client.cancel({ sessionId }),
    closeSession: (sessionId) => client.closeSession({ sessionId }),
    dispose: (opts) => client.dispose(opts),
  });

  // A dsh diagnostic can contain the requested session id; scrub it the same way
  // before anything reaches the pane.
  client.on("stderr", ({ line }) => { if (line.trim()) output.write(`[dsh] ${redactDshSessionId(line, args.session)}\n`); });
  client.on("stdout", ({ line }) => output.write(`[dsh-runner] unexpected agent stdout: ${redactDshSessionId(line.slice(0, 200), args.session)}\n`));
  client.on("notification", ({ method, params }) => core.handleNotification(method, params));
  client.on("request", ({ method, params, respond }) => {
    const outcome = core.handleRequest(method, params);
    if (outcome.refuse) {
      respond.error(outcome.refuse.code, outcome.refuse.message);
      output.write(`[dsh-runner] refused unimplemented agent request ${method}\n`);
      return;
    }
    respond(outcome.decision);
  });
  client.on("exit", (info) => core.handleAgentExit(info));

  core.writePending();
  core.banner({
    profile: args.profile,
    dshHome: args.dshHome,
    activityEnabled: activity.enabled,
    activityRequested: args.activity,
  });

  const onSignal = createDshSignalHandler(core);
  if (installSignalHandlers) {
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }

  try {
    // F12: an unreadable --mcp-servers file is an honest setup failure (sidecar
    // + error marker), never a throw out of the process with no record.
    const mcpServers = readMcpServers(args.mcpServersFile, fsOps);
    client.start();
    const init = await client.initialize({ timeoutMs: args.setupTimeoutMs });
    assertDshAcpSurface(init);
    let setup: { sessionId: string; configOptions?: DshConfigOption[] };
    if (args.session) {
      try {
        // F16: dsh's resume result does not re-report the id; success is dsh's
        // error-free acceptance, and the requested id is the conversation that
        // keeps running. The sidecar records it for the next resume.
        setup = await client.resumeSession({ sessionId: args.session, cwd: args.cwd, mcpServers, timeoutMs: args.setupTimeoutMs });
        // The token is credential-class; never echo it into the captured pane.
        output.write("[dsh-runner] resumed the requested session\n");
      } catch (err) {
        // F11: dsh's own refusal text can contain the requested id; scrub it
        // before it reaches the pane, the sidecar or the adapter.
        const message = redactDshSessionId(err instanceof Error ? err.message : String(err), args.session);
        if (!args.resumeFallbackFresh) throw new Error(`resume refused: ${message}`);
        output.write(`${DSH_RUNNER_ERROR_MARKER} resume failed (${message}); starting a fresh session\n`);
        setup = await client.newSession({ cwd: args.cwd, mcpServers, timeoutMs: args.setupTimeoutMs });
        output.write("[dsh-runner] session created\n");
      }
    } else {
      setup = await client.newSession({ cwd: args.cwd, mcpServers, timeoutMs: args.setupTimeoutMs });
      output.write("[dsh-runner] session created\n");
    }

    // F1/F3: map the declared model/effort onto dsh's advertised selector values
    // and apply them BEFORE READY. An unmappable value fails setup; a READY can
    // therefore never be followed by a model-config death.
    const resolved = resolveDshConfigSelections(setup.configOptions, { model: args.model, effort: args.effort });
    if (!resolved.ok) throw new Error(resolved.error);
    for (const selection of resolved.selections) {
      await client.setConfigOption({
        sessionId: setup.sessionId, configId: selection.configId, value: selection.value, timeoutMs: args.setupTimeoutMs,
      });
      output.write(`[dsh-runner] ${selection.configId}: ${selection.label}\n`);
    }

    core.markReady({ sessionId: setup.sessionId });
  } catch (err) {
    const message = redactDshSessionId(err instanceof Error ? err.message : String(err), args.session);
    core.markSetupFailed({ error: message });
    if (installSignalHandlers) {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
    await client.dispose();
    return core.result();
  }

  // F2: the family's raw-mode input helper aggregates a paste into ONE block
  // (and enforces the byte limit) instead of letting the canonical tty truncate
  // or split a long/multi-line `rig send` before this runner sees it.
  const editor = createRunnerInput(input, output, (block) => core.handleInput(block));
  editor.on("close", () => core.handleInputClosed());

  await core.finished;

  if (installSignalHandlers) {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  editor.close();
  return core.result();
}

function readMcpServers(file: string | null, fsOps: { readFile(path: string): string }): unknown[] {
  if (!file) return [];
  const raw = fsOps.readFile(file);
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`--mcp-servers ${file} must hold a JSON array`);
  return parsed;
}

const defaultFsOps = {
  readFile: (path: string): string => nodeFs.readFileSync(path, "utf8"),
  writeFile: (path: string, content: string): void => { nodeFs.writeFileSync(path, content, { mode: 0o600 }); },
  mkdirp: (path: string): void => { nodeFs.mkdirSync(path, { recursive: true }); },
  rename: (from: string, to: string): void => { nodeFs.renameSync(from, to); },
};

export function isDshRunnerEntryPoint(argvEntry: string | undefined = process.argv[1]): boolean {
  if (!argvEntry) return false;
  return import.meta.url === pathToFileURL(nodePath.resolve(argvEntry)).href
    || nodePath.resolve(argvEntry) === fileURLToPath(import.meta.url);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: DshRunnerArgs;
  try {
    args = parseDshRunnerArgs(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${DSH_RUNNER_ERROR_MARKER} ${message}\n\n${DSH_RUNNER_USAGE}`);
    // exitCode, not exit(): process.exit can truncate the pane output above.
    return 2;
  }
  if (args.help) {
    process.stdout.write(DSH_RUNNER_USAGE);
    return 0;
  }
  const result = await runDshRunner({ args, installSignalHandlers: true });
  return result.code;
}

// Import-safe: only the direct CLI invocation runs a seat. `void`-ed rather
// than top-level awaited so importing this module in a test starts nothing.
if (isDshRunnerEntryPoint()) {
  void main().then((code) => { process.exitCode = code; });
}

export { parseDshRunnerState };
