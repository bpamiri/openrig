// OPR.0.6.DSH1 — the dsh resume adapter.
//
// Restore does not relaunch a fresh seat: it must continue the conversation the
// operator was in. dsh's resume surface is ACP `session/resume {sessionId, cwd,
// mcpServers}`, and dsh is strict about it — the session must be inactive and
// the cwd must match exactly. So this adapter types the same runner command with
// `--session <id>` and then demands PROOF: the sidecar must come back ready AND
// reporting the requested session id. Anything else is an honest failure, never
// a silent fresh start (the adapter contract's stop-and-ask rule).

import nodePath from "node:path";
import { randomUUID } from "node:crypto";
import type { TmuxAdapter } from "./tmux.js";
import type { SeatLaunchEnvironment } from "../domain/seat-launch-environment.js";
import { observeDshPermissionMode } from "../domain/permission-drift.js";
import type { AppliedLaunchObservation } from "../domain/permission-drift.js";
import { validateResumeToken } from "../domain/resume-token-validation.js";
import { yoloEnabled } from "./yolo-mode.js";
import {
  DSH_MAX_SETUP_TIMEOUT_MS, DSH_RESUME_TYPE, buildDshRunnerCommand, buildPendingDshRunnerState, dshPermissionModeForPosture, dshSeatPaths,
  normalizeDshPosture, parseDshRunnerState, provisionDshSeatHome, redactDshSessionId, resolveDshSetupTimeoutMs,
  type DshHomeFsOps, type DshPosture, type DshRunnerState,
} from "./dsh-runner-protocol.js";

export interface DshResumeFsOps extends DshHomeFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  mkdirp(path: string): void;
}

export interface DshResumeAdapterDeps {
  tmux: TmuxAdapter;
  seatLaunchEnvironment?: SeatLaunchEnvironment;
  fs: DshResumeFsOps;
  stateRoot: string;
  runnerEntryPath: string;
  sourceDshHome?: string;
  sharedDshHome?: string;
  dshCommand?: string;
  profile?: string;
  pollMs?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  newLaunchId?: () => string;
  /** The environment the OPENRIG_YOLO decision reads (tests inject), and the
   *  fallback source for OPENRIG_DSH_SETUP_TIMEOUT_MS. */
  env?: NodeJS.ProcessEnv;
  /** Setup request bound, below the 30 s readiness window. Defaults to the
   *  runner's 20 s; falls back to OPENRIG_DSH_SETUP_TIMEOUT_MS. */
  setupTimeoutMs?: number;
}

export type DshResumeResult =
  | { ok: true; appliedLaunch?: AppliedLaunchObservation }
  /** `retry_fresh` is the honest outcome when the seat cannot continue the
   *  requested conversation (dsh refuses a mismatched cwd or an active
   *  session): the caller stops and asks, it never silently starts fresh. */
  | { ok: false; code: "no_resume" | "resume_failed" | "retry_fresh"; message: string };

export class DshResumeAdapter {
  readonly runtime = "dsh" as const;
  private readonly tmux: TmuxAdapter;
  private readonly seatLaunchEnvironment: SeatLaunchEnvironment | undefined;
  private readonly fs: DshResumeFsOps;
  private readonly stateRoot: string;
  private readonly runnerEntryPath: string;
  private readonly sharedDshHome: string | undefined;
  private readonly sourceDshHome: string;
  private readonly dshCommand: string;
  private readonly profile: string;
  private readonly pollMs: number;
  private readonly maxWaitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly newLaunchId: () => string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly setupTimeoutMs: number | undefined;

  constructor(deps: DshResumeAdapterDeps) {
    this.tmux = deps.tmux;
    this.seatLaunchEnvironment = deps.seatLaunchEnvironment;
    this.fs = deps.fs;
    this.stateRoot = deps.stateRoot;
    this.runnerEntryPath = deps.runnerEntryPath;
    this.sharedDshHome = deps.sharedDshHome?.trim()
      || process.env["OPENRIG_DSH_SHARED_HOME"]?.trim()
      || undefined;
    // F17: the same default as the launch path, so a restore of a seat with a
    // missing seat home provisions from the operator's home instead of booting
    // dsh against an empty DSH_HOME.
    this.sourceDshHome = deps.sourceDshHome?.trim()
      || process.env["OPENRIG_DSH_SOURCE_HOME"]?.trim()
      || process.env["DSH_HOME"]?.trim()
      || nodePath.join(process.env["HOME"] ?? "", ".dsh");
    this.dshCommand = deps.dshCommand?.trim() || "dsh";
    this.profile = deps.profile?.trim() || "acp";
    this.pollMs = deps.pollMs ?? 250;
    this.maxWaitMs = deps.maxWaitMs ?? 30_000;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.newLaunchId = deps.newLaunchId ?? (() => randomUUID());
    this.env = deps.env ?? process.env;
    if (deps.setupTimeoutMs !== undefined) {
      this.setupTimeoutMs = resolveDshSetupTimeoutMs(deps.setupTimeoutMs);
      if (this.setupTimeoutMs === undefined) {
        throw new Error(`setupTimeoutMs must be an integer between 1 and ${DSH_MAX_SETUP_TIMEOUT_MS}`);
      }
    } else {
      this.setupTimeoutMs = resolveDshSetupTimeoutMs(this.env["OPENRIG_DSH_SETUP_TIMEOUT_MS"]);
    }
  }

  /** dsh's token is a session ID, so this is the `_session_id` shape — NOT the
   *  `_session_file` shape Pi and OMP use. Claiming the file shape here would
   *  make the two adapters each other's business. */
  canResume(resumeType: string | null, resumeToken: string | null): boolean {
    return resumeType === DSH_RESUME_TYPE && !!resumeToken && resumeToken.trim().length > 0;
  }

  /** Same positional shape as the Pi/OMP resume adapters, so the restore
   *  orchestrator's dispatch stays one readable chain. `identity` carries the
   *  seat's node id and reserved generation, which the runner stamps onto the
   *  activity hooks its resumed session emits. */
  async resume(
    tmuxSessionName: string,
    resumeType: string | null,
    resumeToken: string | null,
    cwd: string,
    model?: string | null,
    resolvedPosture?: "floor" | "full_bypass" | "auto",
    identity: { nodeId?: string; launchGeneration?: string; effort?: string | null } = {},
  ): Promise<DshResumeResult> {
    if (!this.canResume(resumeType, resumeToken)) {
      return { ok: false, code: "no_resume", message: "dsh resume not available" };
    }
    const sessionName = tmuxSessionName;

    const validation = validateResumeToken("dsh", resumeToken);
    if (!validation.ok) {
      return { ok: false, code: "no_resume", message: `dsh resume failed: ${validation.error}` };
    }
    const requestedSessionId = validation.token;

    const paths = dshSeatPaths(this.stateRoot, sessionName);
    const dshHome = this.sharedDshHome ?? paths.dshHome;
    // F7: an explicit posture wins; with none, the family's OPENRIG_YOLO
    // decision applies, so fresh launch and restore cannot disagree.
    const posture: DshPosture = resolvedPosture ? normalizeDshPosture(resolvedPosture) : (yoloEnabled(this.env) ? "full_bypass" : "floor");

    try {
      this.fs.mkdirp(paths.seatRoot);
      if (!this.sharedDshHome && this.sourceDshHome && this.sourceDshHome !== dshHome) {
        provisionDshSeatHome(this.fs, { sourceHome: this.sourceDshHome, seatHome: dshHome, profile: this.profile });
      }
    } catch (err) {
      return { ok: false, code: "resume_failed", message: `dsh resume failed: could not prepare the seat's DSH_HOME: ${(err as Error).message}` };
    }

    const launchId = this.newLaunchId();
    const pending = buildPendingDshRunnerState(launchId, new Date().toISOString(), {
      sessionName, cwd, posture, permissionMode: dshPermissionModeForPosture(posture),
    });
    this.fs.writeFile(paths.runnerStatePath, `${JSON.stringify(pending, null, 2)}\n`);

    const cmd = buildDshRunnerCommand({
      runnerEntryPath: this.runnerEntryPath,
      sessionName,
      stateRoot: this.stateRoot,
      dshHome,
      cwd,
      posture,
      sessionId: requestedSessionId,
      model: model ?? undefined,
      effort: identity.effort ?? undefined,
      nodeId: identity.nodeId,
      generation: identity.launchGeneration,
      launchId,
      dshCommand: this.dshCommand,
      profile: this.profile,
      setupTimeoutMs: this.setupTimeoutMs,
    });
    const command = this.seatLaunchEnvironment
      ? await this.seatLaunchEnvironment.command(sessionName, cmd, {
        nodeId: identity.nodeId, generation: identity.launchGeneration, runtime: this.runtime,
      })
      : cmd;

    let sent = await this.tmux.sendShellCommand(sessionName, command, undefined, { stageIfLong: true, execInScript: true });
    if (!sent.ok && sent.code === "launch_path_too_long" && command !== cmd) {
      sent = await this.tmux.sendShellCommand(sessionName, cmd, undefined, { stageIfLong: true, execInScript: true });
    }
    if (!sent.ok) {
      return { ok: false, code: "resume_failed", message: `dsh resume failed: could not type the resume command (${sent.message})` };
    }

    const verified = await this.verifyResume(sessionName, launchId, requestedSessionId);
    return verified.ok ? { ...verified, appliedLaunch: observeDshPermissionMode(pending.permissionMode) } : verified;
  }

  /** Proof, not optimism: the seat is resumed only when the launch-scoped
   *  sidecar says ready AND names the session we asked to continue. */
  private async verifyResume(sessionName: string, launchId: string, requestedSessionId: string): Promise<DshResumeResult> {
    const attempts = Math.max(1, Math.ceil(this.maxWaitMs / this.pollMs));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const state = this.readRunnerState(sessionName);
      if (state?.launchId === launchId) {
        if (state.exited) {
          const detail = redactDshSessionId(`${state.exited.reason}${state.exited.error ? `: ${state.exited.error}` : ""}`, requestedSessionId);
          // F15: dsh's stable refusals mean "this conversation cannot continue",
          // which is the stop-and-ask outcome, not a hard failure.
          const refused = /session is not resumable|session is already active|cwd does not match|unknown session/i.test(detail);
          return {
            ok: false,
            code: refused ? "retry_fresh" : "resume_failed",
            message: `dsh resume failed: the runner exited (${detail})`,
          };
        }
        if (state.ready) {
          const reported = state.sessionId?.trim();
          if (reported !== requestedSessionId) {
            return {
              ok: false,
              code: "retry_fresh",
              message: "dsh resume failed: the runner is ready but did not continue the requested session",
            };
          }
          return { ok: true };
        }
      }
      if (attempt < attempts - 1) await this.sleep(this.pollMs);
    }
    return { ok: false, code: "resume_failed", message: "dsh resume failed: timed out waiting for the runner to prove the requested session" };
  }

  private readRunnerState(sessionName: string): DshRunnerState | null {
    const { runnerStatePath } = dshSeatPaths(this.stateRoot, sessionName);
    if (!this.fs.exists(runnerStatePath)) return null;
    try {
      return parseDshRunnerState(this.fs.readFile(runnerStatePath));
    } catch {
      return null;
    }
  }
}
