// OPR.0.6.DSH1 — the dsh resume adapter.
//
// Restore does not relaunch a fresh seat: it must continue the conversation the
// operator was in. dsh's resume surface is ACP `session/resume {sessionId, cwd,
// mcpServers}`, and dsh is strict about it — the session must be inactive and
// the cwd must match exactly. So this adapter types the same runner command with
// `--session <id>` and then demands PROOF: the sidecar must come back ready AND
// reporting the requested session id. Anything else is an honest failure, never
// a silent fresh start (the adapter contract's stop-and-ask rule).

import type { TmuxAdapter } from "./tmux.js";
import type { SeatLaunchEnvironment } from "../domain/seat-launch-environment.js";
import { observeDshPermissionMode } from "../domain/permission-drift.js";
import type { AppliedLaunchObservation } from "../domain/permission-drift.js";
import { validateResumeToken } from "../domain/resume-token-validation.js";
import {
  DSH_RESUME_TYPE, buildDshRunnerCommand, dshPermissionModeForPosture, dshSeatPaths, normalizeDshPosture,
  parseDshRunnerState, provisionDshSeatHome,
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

  constructor(deps: DshResumeAdapterDeps) {
    this.tmux = deps.tmux;
    this.seatLaunchEnvironment = deps.seatLaunchEnvironment;
    this.fs = deps.fs;
    this.stateRoot = deps.stateRoot;
    this.runnerEntryPath = deps.runnerEntryPath;
    this.sharedDshHome = deps.sharedDshHome?.trim()
      || process.env["OPENRIG_DSH_SHARED_HOME"]?.trim()
      || undefined;
    this.sourceDshHome = deps.sourceDshHome?.trim()
      || process.env["OPENRIG_DSH_SOURCE_HOME"]?.trim()
      || process.env["DSH_HOME"]?.trim()
      || "";
    this.dshCommand = deps.dshCommand?.trim() || "dsh";
    this.profile = deps.profile?.trim() || "acp";
    this.pollMs = deps.pollMs ?? 250;
    this.maxWaitMs = deps.maxWaitMs ?? 30_000;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.newLaunchId = deps.newLaunchId ?? (() => crypto.randomUUID());
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
    identity: { nodeId?: string; launchGeneration?: string } = {},
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
    const posture: DshPosture = resolvedPosture ? normalizeDshPosture(resolvedPosture) : "floor";

    try {
      this.fs.mkdirp(paths.seatRoot);
      if (!this.sharedDshHome && this.sourceDshHome && this.sourceDshHome !== dshHome) {
        provisionDshSeatHome(this.fs, { sourceHome: this.sourceDshHome, seatHome: dshHome, profile: this.profile });
      }
    } catch (err) {
      return { ok: false, code: "resume_failed", message: `dsh resume failed: could not prepare the seat's DSH_HOME: ${(err as Error).message}` };
    }

    const launchId = this.newLaunchId();
    const pending: DshRunnerState = {
      ready: false,
      launchId,
      sessionName,
      cwd,
      posture,
      permissionMode: dshPermissionModeForPosture(posture),
      sessionId: null,
      updatedAt: new Date().toISOString(),
      exited: null,
    };
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
      nodeId: identity.nodeId,
      generation: identity.launchGeneration,
      launchId,
      dshCommand: this.dshCommand,
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
          return {
            ok: false,
            code: "resume_failed",
            message: `dsh resume failed: the runner exited (${state.exited.reason}${state.exited.error ? `: ${state.exited.error}` : ""})`,
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
