// OPR.0.6.DSH1 — the dsh (DeepSeek Harness) runtime adapter.
//
// dsh is protocol-first and OpenRig seats are tmux-first, so this adapter is the
// same shape as the Pi adapter: it launches an OpenRig-owned runner inside the
// seat's normal tmux pane, and the runner hosts `dsh --profile acp` (ACP v1 over
// NDJSON on stdio). send/capture stay tmux-native — `rig send` types into the
// pane, the runner turns pane stdin into `session/prompt`, and the mirrored
// transcript comes back out of the pane. Readiness, session identity, activity
// and permission answers come from the ACP protocol and the runner's sidecar,
// never from pane scraping.
//
// Two facts about dsh shape everything below:
//   1. `$DSH_HOME` must be WRITABLE: dsh rewrites
//      `$DSH_HOME/profiles/<name>/cordis.yml` on every boot. Pointing a seat at
//      the operator's own `~/.dsh` would rewrite the profile tree their own dsh
//      sessions are using, so every seat gets its own home, assembled from the
//      operator's by copying the profile and symlinking the shared/secret parts.
//   2. A dsh session id cannot be chosen and is not a file: it is
//      `session-<uuid>`, reported by `session/new` / `session/resume`. The
//      resume token is therefore id-shaped, not path-shaped.

import nodePath from "node:path";
import { randomUUID } from "node:crypto";
import type { TmuxAdapter } from "./tmux.js";
import type { SeatLaunchEnvironment } from "../domain/seat-launch-environment.js";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile,
  InstalledResource, ProjectionResult, StartupDeliveryResult, ReadinessResult,
  HarnessLaunchResult, ForkSource,
} from "../domain/runtime-adapter.js";
import { resolveConcreteHint } from "../domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../domain/projection-planner.js";
import { mergeManagedBlock } from "../domain/managed-blocks.js";
import { observeDshPermissionMode } from "../domain/permission-drift.js";
import { DSH_RESUME_TYPE } from "./dsh-runner-protocol.js";
import {
  DSH_RUNNER_ERROR_MARKER, DSH_RUNNER_EXIT_MARKER, DSH_RUNNER_READY_MARKER,
  buildDshRunnerCommand, dshPermissionModeForPosture, dshSeatPaths, normalizeDshPosture,
  parseDshRunnerState, provisionDshSeatHome, sanitizeDshSessionName,
  type DshHomeFsOps, type DshPosture, type DshRunnerState,
} from "./dsh-runner-protocol.js";

const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

export interface DshAdapterFsOps extends DshHomeFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  mkdirp(path: string): void;
  listFiles?(dirPath: string): string[];
  statMode?(path: string): number;
  chmod?(path: string, mode: number): void;
}

export interface DshRuntimeAdapterDeps {
  tmux: TmuxAdapter;
  seatLaunchEnvironment?: SeatLaunchEnvironment;
  fsOps: DshAdapterFsOps;
  /** Root under which every dsh seat gets its isolated state dir.
   *  Typically <OPENRIG_HOME>/state/dsh. */
  stateRoot: string;
  /** Absolute path to the compiled dsh-runner entry in the daemon dist. */
  runnerEntryPath: string;
  /** The operator's own dsh home, read-only, used as the template a seat home
   *  is assembled from. Defaults to $DSH_HOME, else ~/.dsh. */
  sourceDshHome?: string;
  /** When set, seats run against this DSH_HOME directly instead of a per-seat
   *  copy. The operator owns writability and profile isolation; the adapter
   *  will NOT provision it. Falls back to `OPENRIG_DSH_SHARED_HOME`. */
  sharedDshHome?: string;
  /** `dsh` executable for a seat. Default "dsh" (resolved on the pane's PATH). */
  dshCommand?: string;
  /** dsh profile. Default "acp" — the only dsh profile that is a seat. */
  profile?: string;
  sleep?: (ms: number) => Promise<void>;
  /** Launch-attempt id minting (tests inject; defaults to randomUUID). */
  newLaunchId?: () => string;
}

export class DshRuntimeAdapter implements RuntimeAdapter {
  readonly runtime = "dsh" as const;
  private readonly tmux: TmuxAdapter;
  private readonly seatLaunchEnvironment: SeatLaunchEnvironment | undefined;
  private readonly fs: DshAdapterFsOps;
  protected readonly stateRoot: string;
  private readonly runnerEntryPath: string;
  private readonly sharedDshHome: string | undefined;
  private readonly sourceDshHome: string;
  private readonly dshCommand: string;
  private readonly profile: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly newLaunchId: () => string;

  constructor(deps: DshRuntimeAdapterDeps) {
    this.tmux = deps.tmux;
    this.seatLaunchEnvironment = deps.seatLaunchEnvironment;
    this.fs = deps.fsOps;
    this.stateRoot = deps.stateRoot;
    this.runnerEntryPath = deps.runnerEntryPath;
    this.sharedDshHome = deps.sharedDshHome?.trim()
      || process.env["OPENRIG_DSH_SHARED_HOME"]?.trim()
      || undefined;
    this.sourceDshHome = deps.sourceDshHome?.trim()
      || process.env["OPENRIG_DSH_SOURCE_HOME"]?.trim()
      || process.env["DSH_HOME"]?.trim()
      || nodePath.join(process.env["HOME"] ?? "", ".dsh");
    this.dshCommand = deps.dshCommand?.trim() || "dsh";
    this.profile = deps.profile?.trim() || "acp";
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.newLaunchId = deps.newLaunchId ?? (() => randomUUID());
  }

  /** The seat's DSH_HOME: an explicit shared home, or a per-seat writable copy. */
  seatDshHome(sessionName: string): string {
    return this.sharedDshHome ?? dshSeatPaths(this.stateRoot, sessionName).dshHome;
  }

  /** The dsh sidecar reader shape `deriveResumeToken`'s dsh branch consumes.
   *  A dsh token is a session ID, not a path, so this is a separate reader from
   *  the Pi one (whose contract is a session file). */
  readSessionId(sessionName: string): { ok: true; sessionId: string } | { ok: false; reason: string } {
    const state = this.readRunnerState(sessionName);
    if (state === null) {
      const { runnerStatePath } = dshSeatPaths(this.stateRoot, sessionName);
      return this.fs.exists(runnerStatePath)
        ? { ok: false, reason: "parse_error" }
        : { ok: false, reason: "missing_sidecar" };
    }
    const sessionId = state.sessionId?.trim();
    if (!sessionId) return { ok: false, reason: "missing_sidecar" };
    return { ok: true, sessionId };
  }

  async listInstalled(binding: NodeBinding): Promise<InstalledResource[]> {
    const results: InstalledResource[] = [];
    const sessionName = binding.tmuxSession;
    if (!sessionName) return results;
    const skillsDir = nodePath.join(binding.cwd, ".dsh", "skills");
    if (this.fs.exists(skillsDir) && this.fs.listFiles) {
      for (const file of this.fs.listFiles(skillsDir)) {
        results.push({ effectiveId: file, category: "skill", installedPath: nodePath.join(skillsDir, file) });
      }
    }
    return results;
  }

  /** Conflict detection must inspect the seat's own project tree (dsh skills are
   *  project-scoped and hot-watched), not a Claude sibling's directory. */
  skillTargetPath(_tmuxSession: string | null, effectiveId: string): string | null {
    return null;
  }

  async project(plan: ProjectionPlan, binding: NodeBinding): Promise<ProjectionResult> {
    const projected: string[] = [];
    const warnings: string[] = [];
    const skipped: string[] = [];
    const failed: Array<{ effectiveId: string; error: string }> = [];

    for (const entry of plan.entries) {
      const directorySkill = entry.category === "skill"
        && this.fs.exists(nodePath.join(entry.absolutePath, "SKILL.md"));
      if (entry.classification === "no_op" && !directorySkill) {
        skipped.push(entry.effectiveId);
        continue;
      }
      try {
        if (this.projectEntry(entry, binding, warnings)) projected.push(entry.effectiveId);
        else skipped.push(entry.effectiveId);
      } catch (err) {
        failed.push({ effectiveId: entry.effectiveId, error: (err as Error).message });
      }
    }

    return { projected, skipped, failed, ...(warnings.length ? { warnings } : {}) };
  }

  async deliverStartup(files: ResolvedStartupFile[], binding: NodeBinding): Promise<StartupDeliveryResult> {
    const warnings: string[] = [];
    let delivered = 0;
    const failed: Array<{ path: string; error: string }> = [];

    for (const file of files) {
      try {
        const content = this.fs.readFile(file.absolutePath);
        const hint = file.deliveryHint === "auto" ? resolveConcreteHint(file.path, content) : file.deliveryHint;
        switch (hint) {
          case "guidance_merge": {
            // dsh reads the project chain (AGENTS.md / CLAUDE.md / *.local.md),
            // so guidance is an ADDITIVE managed-block merge, never a replace.
            const targetPath = nodePath.join(binding.cwd, "AGENTS.md");
            if (!this.mergeGuidance(targetPath, file.path, content, warnings)) continue;
            break;
          }
          case "skill_install": {
            // dsh's strongest area: a skill directory under the project is
            // hot-watched, so a seat picks it up without a restart.
            const targetDir = nodePath.join(
              binding.cwd, ".dsh", "skills",
              nodePath.basename(nodePath.dirname(file.absolutePath)),
            );
            if (!this.fs.copyDir) throw new Error("fs.copyDir is required to install a dsh skill");
            this.fs.mkdirp(targetDir);
            this.fs.copyDir(file.absolutePath, targetDir);
            break;
          }
          case "send_text": {
            if (binding.tmuxSession) {
              const textResult = await this.tmux.sendText(binding.tmuxSession, content);
              if (!textResult.ok) throw new Error(textResult.message);
              await this.sleep(200);
              const submitResult = await this.tmux.sendKeys(binding.tmuxSession, ["Enter"]);
              if (!submitResult.ok) throw new Error(submitResult.message);
            }
            break;
          }
        }
        delivered += 1;
      } catch (err) {
        if (file.required) failed.push({ path: file.path, error: (err as Error).message });
      }
    }

    return { delivered, failed, ...(warnings.length ? { warnings } : {}) };
  }

  async launchHarness(
    binding: NodeBinding,
    opts: { name: string; resumeToken?: string; forkSource?: ForkSource },
  ): Promise<HarnessLaunchResult> {
    if (!binding.tmuxSession) {
      return { ok: false, error: "No tmux session bound — cannot launch the dsh harness" };
    }
    if (opts.resumeToken && opts.forkSource) {
      return { ok: false, error: "resumeToken and forkSource are mutually exclusive — pick one" };
    }
    if (opts.forkSource) {
      // dsh has no fork surface in its ACP profile. Refuse rather than start a
      // fresh session and mislabel it a fork.
      return {
        ok: false,
        error: `dsh fork: not supported — dsh's ACP profile exposes no fork operation (requested kind="${opts.forkSource.kind}")`,
      };
    }

    const sessionName = binding.tmuxSession;
    const paths = dshSeatPaths(this.stateRoot, sessionName);
    const dshHome = this.seatDshHome(sessionName);
    const posture = this.resolvePosture(binding);

    try {
      this.fs.mkdirp(paths.seatRoot);
      this.prepareDshHome(dshHome);
    } catch (err) {
      return { ok: false, error: `dsh launch: could not prepare the seat's DSH_HOME: ${(err as Error).message}` };
    }

    // Launch-attempt scoping: overwrite any stale sidecar from a prior runner
    // instance with a pending record BEFORE the command is typed, so only states
    // stamped with THIS attempt's launchId can make the seat look ready.
    const launchId = this.newLaunchId();
    const pending: DshRunnerState = {
      ready: false,
      launchId,
      sessionName,
      cwd: binding.cwd,
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
      cwd: binding.cwd,
      posture,
      sessionId: opts.resumeToken,
      model: binding.model,
      nodeId: binding.nodeId,
      // The occupant generation the activity hooks must carry: without it the
      // daemon treats every hook as unverifiable and falls back to sampling
      // (issue #29 on Pi was exactly this).
      generation: binding.launchGeneration,
      launchId,
      dshCommand: this.dshCommand,
    });

    const command = this.seatLaunchEnvironment
      ? await this.seatLaunchEnvironment.command(sessionName, cmd, {
        nodeId: binding.nodeId,
        generation: binding.launchGeneration,
        runtime: this.runtime,
      })
      : cmd;

    let textResult = await this.tmux.sendShellCommand(sessionName, command, undefined, { stageIfLong: true, execInScript: true });
    // Retain the bare-command fallback when routing cannot fit the wrapped form.
    if (!textResult.ok && textResult.code === "launch_path_too_long" && command !== cmd) {
      textResult = await this.tmux.sendShellCommand(sessionName, cmd, undefined, { stageIfLong: true, execInScript: true });
    }
    if (!textResult.ok) {
      return { ok: false, error: `Failed to send launch command: ${textResult.message}` };
    }

    const state = await this.waitForRunnerReady(sessionName, launchId);
    if (!state.ok) return state.failure;

    const sessionId = state.value.sessionId?.trim();
    if (!sessionId) {
      return { ok: false, error: "dsh launch: the runner became ready but reported no session id" };
    }
    if (opts.resumeToken && sessionId !== opts.resumeToken) {
      // An exact resume must continue the requested conversation. dsh refuses a
      // mismatched cwd or a live session, and a runner that came up on any other
      // id started a different conversation — say so instead of persisting it.
      return {
        ok: false,
        error: `dsh resume: the runner is ready but reports session ${sanitizeDshSessionName(sessionId)}, not the requested one`,
        recovery: "retry_fresh",
      };
    }

    return { ok: true, resumeToken: sessionId, resumeType: DSH_RESUME_TYPE, appliedLaunch: observeDshPermissionMode(pending.permissionMode) };
  }

  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    if (!binding.tmuxSession) return { ready: false, reason: "No tmux session bound" };
    const sessionName = binding.tmuxSession;
    const alive = await this.tmux.hasSession(sessionName);
    if (!alive) return { ready: false, reason: "tmux session not responsive" };

    // A sidecar or a scrollback marker can outlive the runner process, so a
    // ready signal only counts while the pane's foreground process is not back
    // at a shell.
    const paneCommand = (await this.tmux.getPaneCommand(sessionName)) ?? "";
    const atShell = SHELL_COMMANDS.has(paneCommand);
    const state = this.readRunnerState(sessionName);
    if (state?.exited) {
      return {
        ready: false,
        reason: `dsh-runner exited (${state.exited.reason}${state.exited.code === undefined ? "" : `, code ${state.exited.code}`})`,
        code: "runner_exited",
      };
    }
    if (state?.ready) {
      if (atShell) {
        return { ready: false, reason: "dsh-runner sidecar says ready but the pane is back at a shell (runner process gone)", code: "runner_exited" };
      }
      return { ready: true };
    }

    const paneContent = (await this.tmux.capturePaneContent(sessionName, 40)) ?? "";
    if (paneContent.includes(DSH_RUNNER_ERROR_MARKER)) {
      return { ready: false, reason: "dsh-runner reported an error in the pane", code: "runner_error" };
    }
    if (paneContent.includes(DSH_RUNNER_EXIT_MARKER)) {
      return { ready: false, reason: "dsh-runner exited", code: "runner_exited" };
    }
    if (paneContent.includes(DSH_RUNNER_READY_MARKER)) {
      if (atShell) {
        return { ready: false, reason: "READY marker is stale scrollback; the pane is back at a shell", code: "runner_exited" };
      }
      return { ready: true };
    }
    return { ready: false, reason: "dsh-runner has not reported ready yet", code: "awaiting_runtime" };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** The seat's launch posture. dsh bundles sandbox + approval, so it needs a
   *  permission mode at launch, and there is no safe default to guess: an
   *  attached policy is authoritative, otherwise the seat is on the floor. */
  private resolvePosture(binding: NodeBinding): DshPosture {
    if (binding.launchPosture) return normalizeDshPosture(binding.launchPosture);
    return "floor";
  }

  /** Assemble (or adopt) the seat's writable DSH_HOME. Idempotent, and a no-op
   *  when the operator supplied an explicit shared home. */
  private prepareDshHome(dshHome: string): void {
    if (this.sharedDshHome) return;
    if (nodePath.resolve(this.sourceDshHome) === nodePath.resolve(dshHome)) return;
    provisionDshSeatHome(this.fs, { sourceHome: this.sourceDshHome, seatHome: dshHome, profile: this.profile });
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

  private async waitForRunnerReady(
    sessionName: string,
    launchId: string,
  ): Promise<{ ok: true; value: DshRunnerState } | { ok: false; failure: HarnessLaunchResult }> {
    const pollMs = 250;
    // ~30s: a cold dsh boot materialises its profile and can be slow on first run.
    const attempts = 120;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const state = this.readRunnerState(sessionName);
      if (state?.launchId === launchId) {
        if (state.exited) {
          const paneContent = (await this.tmux.capturePaneContent(sessionName, 40)) ?? "";
          return {
            ok: false,
            failure: {
              ok: false,
              error: `dsh launch failed: the runner exited (${state.exited.reason}${state.exited.error ? `: ${state.exited.error}` : ""})`,
              recovery: "attention_required",
              evidence: paneContent.split("\n").slice(-12).join("\n"),
            },
          };
        }
        if (state.ready) return { ok: true, value: state };
      }
      if (attempt < attempts - 1) await this.sleep(pollMs);
    }
    return {
      ok: false,
      failure: {
        ok: false,
        error: "dsh launch: timed out waiting for the runner to report ready",
        recovery: "attention_required",
      },
    };
  }

  private projectEntry(entry: ProjectionEntry, binding: NodeBinding, warnings: string[]): boolean {
    if (entry.category === "guidance" && entry.mergeStrategy === "managed_block") {
      const targetPath = nodePath.join(binding.cwd, "AGENTS.md");
      return this.mergeGuidance(targetPath, entry.effectiveId, this.fs.readFile(entry.absolutePath), warnings);
    }
    if (entry.category === "skill") {
      if (!this.fs.copyDir) return false;
      const targetDir = nodePath.join(binding.cwd, ".dsh", "skills", entry.effectiveId);
      this.fs.mkdirp(targetDir);
      this.fs.copyDir(entry.absolutePath, targetDir);
      return true;
    }
    // Plugins / subagents / agent images have no dsh projection target: dsh's
    // plug-in surface is its own (cordis bundles), not Claude's or Codex's. An
    // honest skip, never a misdelivery.
    return false;
  }

  private mergeGuidance(targetPath: string, blockId: string, content: string, warnings: string[]): boolean {
    // Per-seat `rig-role` content collides across pod-mates when merged into a
    // shared project file; it is delivered via send_text instead. See ADR-0006.
    if (blockId === "rig-role") {
      console.log(`[openrig] skip: effectiveId is rig-role, per-seat delivery via send_text path required (target=${targetPath})`);
      return false;
    }
    mergeManagedBlock(this.fs as unknown as Parameters<typeof mergeManagedBlock>[0], targetPath, blockId, content, {
      warnings,
      replaceBlockIds: blockId === "openrig-start.md" ? ["using-openrig.md"] : [],
    });
    return true;
  }
}

/** Subclass hook the resume adapter shares: the seat's state root and runner. */
export interface DshResumePaths {
  stateRoot: string;
  runnerEntryPath: string;
}
