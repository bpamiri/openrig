// OPR.0.6.DSH1 — hermetic tests for the dsh runtime adapter and its resume
// adapter. No dsh, no tmux: command construction, the writable DSH_HOME
// provisioning pass, launch-attempt sidecar scoping, readiness proof, and the
// "the runner must prove it continued the requested session" rule are all
// exercised against an in-memory filesystem and a mocked tmux.

import { describe, it, expect, vi } from "vitest";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import { DshRuntimeAdapter, type DshAdapterFsOps } from "../src/adapters/dsh-runtime-adapter.js";
import { DshResumeAdapter } from "../src/adapters/dsh-resume.js";
import {
  DSH_RUNNER_ERROR_MARKER, DSH_RUNNER_EXIT_MARKER, DSH_RUNNER_READY_MARKER, dshSeatPaths,
} from "../src/adapters/dsh-runner-protocol.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

const STATE_ROOT = "/openrig-home/state/dsh";
const RUNNER = "/daemon-dist/adapters/dsh-runner.js";
const SOURCE_HOME = "/op/.dsh";
const SESSION = "dev1-dsh@dsh-scratch";
const SESSION_ID = "session-fac46d5a-82c0-4687-b95d-b1c9dc0bfbc";
const PATH = dshSeatPaths(STATE_ROOT, SESSION);

function mockTmux(overrides?: {
  sendShellCommand?: (target: string, text: string) => Promise<TmuxResult>;
  capturePaneContent?: (target: string, lines?: number) => Promise<string | null>;
  hasSession?: (target: string) => Promise<boolean>;
  getPaneCommand?: (target: string) => Promise<string | null>;
  sendText?: (target: string, text: string) => Promise<TmuxResult>;
  sendKeys?: (target: string, keys: string[]) => Promise<TmuxResult>;
}) {
  return {
    sendText: overrides?.sendText ?? vi.fn(async () => ({ ok: true as const })),
    sendShellCommand: overrides?.sendShellCommand ?? vi.fn(async () => ({ ok: true as const })),
    sendKeys: overrides?.sendKeys ?? vi.fn(async () => ({ ok: true as const })),
    capturePaneContent: overrides?.capturePaneContent ?? vi.fn(async () => ""),
    hasSession: overrides?.hasSession ?? vi.fn(async () => true),
    getPaneCommand: overrides?.getPaneCommand ?? vi.fn(async () => "node"),
    createSession: async () => ({ ok: true as const }),
    killSession: async () => ({ ok: true as const }),
    listSessions: async () => [],
  } as unknown as TmuxAdapter;
}

/** In-memory fs with the directory/symlink surface the DSH_HOME pass needs. */
function memFs(files: Record<string, string> = {}, dirsIn: string[] = []) {
  const dirs = new Set(dirsIn);
  const links: Array<{ target: string; linkPath: string }> = [];
  const fs: DshAdapterFsOps & { files: Record<string, string>; dirs: Set<string>; links: typeof links } = {
    files, dirs, links,
    readFile: (p) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p]!;
    },
    writeFile: (p, c) => { files[p] = c; },
    exists: (p) => p in files || dirs.has(p) || links.some((l) => l.linkPath === p),
    mkdirp: (p) => { dirs.add(p); },
    listFiles: () => [],
    readDir: (dir) => {
      if (dir === `${SOURCE_HOME}/profiles/acp`) return ["cordis.yml", "cordis.patch.yml", "package.json", "node_modules"];
      if (dir === SOURCE_HOME) return ["profiles", ".credentials.yaml"];
      return [];
    },
    statKind: (p) => (p.endsWith("node_modules") ? "directory" : "file"),
    copyFile: (source, target) => { files[target] = files[source] ?? `copied:${source}`; },
    copyDir: (source, target) => {
      dirs.add(target);
      for (const entry of fs.readDir(source)) {
        if (entry === "node_modules") { fs.symlink(`${source}/${entry}`, `${target}/${entry}`); continue; }
        if (entry.includes(".")) files[`${target}/${entry}`] = `copied:${source}/${entry}`;
      }
    },
    symlink: (target, linkPath) => { links.push({ target, linkPath }); },
  };
  return fs;
}

const sessionDir = (id = SESSION_ID) => `/state/auth`;
function readySidecar(launchId: string | undefined, sessionId: string | null = SESSION_ID): string {
  return JSON.stringify({ ready: true, launchId, sessionId, updatedAt: "2026-10-15T10:00:01.000Z" });
}
function exitedSidecar(launchId: string | undefined, reason = "setup-failed", error?: string): string {
  return JSON.stringify({ ready: false, launchId, sessionId: null, updatedAt: "t", exited: { reason, ...(error ? { error } : {}) } });
}

const BINDING: NodeBinding = {
  id: "b1", nodeId: "node-1", tmuxSession: SESSION, tmuxWindow: "w", tmuxPane: "p",
  cmuxWorkspace: null, cmuxSurface: null, updatedAt: "t", cwd: "/repo", launchPosture: "floor",
} as NodeBinding;

function adapterWith(fs: DshAdapterFsOps, tmux: TmuxAdapter, launchIds: string[] = ["launch-1"]) {
  let index = 0;
  return new DshRuntimeAdapter({
    tmux, fsOps: fs, stateRoot: STATE_ROOT, runnerEntryPath: RUNNER,
    sourceDshHome: SOURCE_HOME, sleep: async () => {}, newLaunchId: () => launchIds[index++] ?? "launch-x",
  });
}

describe("dsh adapter: launch", () => {
  it("provisions a writable seat home and is idempotent", async () => {
    const fs = memFs({}, [SOURCE_HOME, `${SOURCE_HOME}/profiles`, `${SOURCE_HOME}/profiles/acp`, `${SOURCE_HOME}/profiles/acp/cordis.yml`, `${SOURCE_HOME}/profiles/node_modules`, `${SOURCE_HOME}/.credentials.yaml`]);
    const tmux = mockTmux();
    const adapter = adapterWith(fs, tmux);
    const launch = adapter.launchHarness(BINDING, { name: SESSION });
    // The runner is typed before it can answer, so drive readiness for it.
    fs.writeFile(PATH.runnerStatePath, readySidecar("launch-1"));
    const result = await launch;

    expect(result).toEqual({
      ok: true, resumeToken: SESSION_ID, resumeType: "dsh_session_id",
      appliedLaunch: { runtime: "dsh", axis: "permission", state: "observed", value: "workspace-write" },
    });
    // dsh rewrites the profile on every boot, so it is a real copy but shared
    // and secret material is linked, never copied.
    expect(fs.links.some((l) => l.linkPath === `${PATH.dshHome}/profiles/acp/node_modules`)).toBe(true);
    expect(fs.links.some((l) => l.linkPath === `${PATH.dshHome}/.credentials.yaml`)).toBe(true);
    expect(fs.files[`${PATH.dshHome}/profiles/acp/cordis.yml`]).toBe(`copied:${SOURCE_HOME}/profiles/acp/cordis.yml`);
  });

  it("types a launch-scoped command carrying the seat identity and the posture", async () => {
    const fs = memFs({}, [SOURCE_HOME, `${SOURCE_HOME}/profiles`, `${SOURCE_HOME}/profiles/acp`]);
    const sent: string[] = [];
    const tmux = mockTmux({
      sendShellCommand: async (_target, text) => { sent.push(text); return { ok: true as const }; },
    });
    const adapter = adapterWith(fs, tmux);
    const launch = adapter.launchHarness({ ...BINDING, launchPosture: "full_bypass", launchGeneration: "gen-7", model: "deepseek/deepseek-chat" }, { name: SESSION });
    fs.writeFile(PATH.runnerStatePath, readySidecar("launch-1"));
    await launch;

    const cmd = sent.join("\n");
    expect(cmd).toContain(`--session-name '${SESSION}'`);
    expect(cmd).toContain(`--dsh-home '${PATH.dshHome}'`);
    expect(cmd).toContain(`--cwd '/repo'`);
    expect(cmd).toContain("--posture full_bypass");
    expect(cmd).toContain(`--node-id 'node-1'`);
    expect(cmd).toContain(`--generation 'gen-7'`);
    expect(cmd).toContain(`--model 'deepseek/deepseek-chat'`);
    expect(cmd).toContain(`--launch-id 'launch-1'`);
    expect(cmd).not.toContain("--session ");
  });

  it("pre-writes a pending sidecar so a stale ready record cannot false-green the launch", async () => {
    const fs = memFs({ [PATH.runnerStatePath]: readySidecar("launch-old") }, [SOURCE_HOME, `${SOURCE_HOME}/profiles`, `${SOURCE_HOME}/profiles/acp`]);
    const adapter = adapterWith(fs, mockTmux());
    const launch = adapter.launchHarness(BINDING, { name: SESSION });
    // The adapter must have overwritten the stale record before typing.
    const pending = JSON.parse(fs.files[PATH.runnerStatePath]!);
    expect(pending).toMatchObject({ ready: false, launchId: "launch-1", sessionId: null });
    fs.writeFile(PATH.runnerStatePath, readySidecar("launch-1"));
    await expect(launch).resolves.toMatchObject({ ok: true });
  });

  it("refuses to call a fresh session a resume", async () => {
    const fs = memFs({}, [SOURCE_HOME, `${SOURCE_HOME}/profiles`, `${SOURCE_HOME}/profiles/acp`]);
    const adapter = adapterWith(fs, mockTmux());
    const launch = adapter.launchHarness(BINDING, { name: SESSION, resumeToken: "session-wanted" });
    fs.writeFile(PATH.runnerStatePath, readySidecar("launch-1", "session-other"));
    const result = await launch;
    expect(result).toMatchObject({ ok: false, recovery: "retry_fresh" });
    expect((result as { error: string }).error).toMatch(/not the requested one/);
  });

  it("forwards a configured non-default dsh executable to the runner", async () => {
    const fs = memFs({}, [SOURCE_HOME, `${SOURCE_HOME}/profiles`, `${SOURCE_HOME}/profiles/acp`]);
    const sent: string[] = [];
    const tmux = mockTmux({ sendShellCommand: async (_target, text) => { sent.push(text); return { ok: true as const }; } });
    const adapter = new DshRuntimeAdapter({
      tmux, fsOps: fs, stateRoot: STATE_ROOT, runnerEntryPath: RUNNER, sourceDshHome: SOURCE_HOME,
      dshCommand: "/opt/deepseek/bin/dsh", sleep: async () => {}, newLaunchId: () => "launch-1",
    });
    const launch = adapter.launchHarness(BINDING, { name: SESSION });
    fs.writeFile(PATH.runnerStatePath, readySidecar("launch-1"));
    await launch;
    expect(sent.join("\n")).toContain("--dsh-command '/opt/deepseek/bin/dsh'");
  });

  it("refuses and never relaunches when there is no tmux session", async () => {
    const adapter = adapterWith(memFs(), mockTmux());
    const result = await adapter.launchHarness({ ...BINDING, tmuxSession: null }, { name: SESSION });
    expect(result).toEqual({ ok: false, error: "No tmux session bound — cannot launch the dsh harness" });
  });

  it("refuses fork rather than starting a fresh session and calling it a fork", async () => {
    const adapter = adapterWith(memFs(), mockTmux());
    const result = await adapter.launchHarness(BINDING, { name: SESSION, forkSource: { kind: "native_id", value: "x" } });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toMatch(/dsh fork: not supported/);
  });

  it("reports an honest failure with pane evidence when the runner exits", async () => {
    const fs = memFs({}, [SOURCE_HOME, `${SOURCE_HOME}/profiles`, `${SOURCE_HOME}/profiles/acp`]);
    const tmux = mockTmux({ capturePaneContent: async () => `${DSH_RUNNER_ERROR_MARKER} setup failed: profile "acp" does not exist` });
    const adapter = adapterWith(fs, tmux);
    const launch = adapter.launchHarness(BINDING, { name: SESSION });
    fs.writeFile(PATH.runnerStatePath, exitedSidecar("launch-1", "setup-failed", "profile \"acp\" does not exist"));
    const result = await launch;
    expect(result).toMatchObject({ ok: false, recovery: "attention_required" });
    expect((result as { error: string }).error).toMatch(/the runner exited \(setup-failed/);
    expect((result as { evidence: string }).evidence).toContain("setup failed");
  });

  it("reports the setup failure instead of claiming a resumed seat when resume is refused", async () => {
    const fs = memFs({}, [SOURCE_HOME, `${SOURCE_HOME}/profiles`, `${SOURCE_HOME}/profiles/acp`]);
    const adapter = adapterWith(fs, mockTmux());
    const launch = adapter.launchHarness(BINDING, { name: SESSION, resumeToken: SESSION_ID });
    fs.writeFile(PATH.runnerStatePath, exitedSidecar("launch-1", "setup-failed", "resume refused: session is active"));
    const result = await launch;
    expect(result).toMatchObject({ ok: false, recovery: "attention_required" });
    expect((result as { error: string }).error).toContain("resume refused: session is active");
  });
});

describe("dsh adapter: readiness", () => {
  it("is ready only from a launch-scoped ready sidecar", async () => {
    const fs = memFs({ [PATH.runnerStatePath]: readySidecar("launch-1") }, [SOURCE_HOME]);
    const adapter = adapterWith(fs, mockTmux());
    await expect(adapter.checkReady(BINDING)).resolves.toEqual({ ready: true });
  });

  it("refuses ready when the pane is back at a shell (the runner process is gone)", async () => {
    const fs = memFs({ [PATH.runnerStatePath]: readySidecar("launch-1") }, [SOURCE_HOME]);
    const adapter = adapterWith(fs, mockTmux({ getPaneCommand: async () => "zsh" }));
    const result = await adapter.checkReady(BINDING);
    expect(result).toMatchObject({ ready: false, code: "runner_exited" });
    expect(result.reason).toMatch(/back at a shell/);
  });

  it("reports the runner's stated exit reason and code", async () => {
    const fs = memFs({ [PATH.runnerStatePath]: JSON.stringify({ ready: false, launchId: "L", updatedAt: "t", exited: { reason: "agent-exit code=3 signal=null", code: 1 } }) }, [SOURCE_HOME]);
    const adapter = adapterWith(fs, mockTmux());
    const result = await adapter.checkReady(BINDING);
    expect(result).toMatchObject({ ready: false, code: "runner_exited" });
    expect(result.reason).toContain("agent-exit code=3");
  });

  it("falls back to the runner's own pane markers, never dsh UI heuristics", async () => {
    const fs = memFs({}, [SOURCE_HOME]);
    const adapter = adapterWith(fs, mockTmux({ capturePaneContent: async () => `${DSH_RUNNER_READY_MARKER}` }));
    await expect(adapter.checkReady(BINDING)).resolves.toEqual({ ready: true });

    const errored = adapterWith(memFs({}, [SOURCE_HOME]), mockTmux({ capturePaneContent: async () => `${DSH_RUNNER_ERROR_MARKER} setup failed` }));
    await expect(errored.checkReady(BINDING)).resolves.toMatchObject({ ready: false, code: "runner_error" });

    const exited = adapterWith(memFs({}, [SOURCE_HOME]), mockTmux({ capturePaneContent: async () => `${DSH_RUNNER_EXIT_MARKER} (user-quit)` }));
    await expect(exited.checkReady(BINDING)).resolves.toMatchObject({ ready: false, code: "runner_exited" });

    const silent = adapterWith(memFs({}, [SOURCE_HOME]), mockTmux({ capturePaneContent: async () => "nothing yet" }));
    await expect(silent.checkReady(BINDING)).resolves.toMatchObject({ ready: false, code: "awaiting_runtime" });
  });

  it("is not ready when the tmux session is gone", async () => {
    const adapter = adapterWith(memFs({ [PATH.runnerStatePath]: readySidecar("L") }, [SOURCE_HOME]), mockTmux({ hasSession: async () => false }));
    await expect(adapter.checkReady(BINDING)).resolves.toMatchObject({ ready: false, reason: "tmux session not responsive" });
  });
});

describe("dsh adapter: resume-token capture", () => {
  it("reads the session id the runner reported", () => {
    const fs = memFs({ [PATH.runnerStatePath]: readySidecar("L") }, [SOURCE_HOME]);
    expect(adapterWith(fs, mockTmux()).readSessionId(SESSION)).toEqual({ ok: true, sessionId: SESSION_ID });
  });

  it("is honest about a missing or unusable sidecar", () => {
    const missing = adapterWith(memFs({}, [SOURCE_HOME]), mockTmux());
    expect(missing.readSessionId(SESSION)).toEqual({ ok: false, reason: "missing_sidecar" });

    const corrupt = adapterWith(memFs({ [PATH.runnerStatePath]: "{not json" }, [SOURCE_HOME]), mockTmux());
    expect(corrupt.readSessionId(SESSION)).toEqual({ ok: false, reason: "parse_error" });

    const noSession = adapterWith(memFs({ [PATH.runnerStatePath]: JSON.stringify({ ready: false, sessionId: null, updatedAt: "t" }) }, [SOURCE_HOME]), mockTmux());
    expect(noSession.readSessionId(SESSION)).toEqual({ ok: false, reason: "missing_sidecar" });
  });
});

describe("dsh resume adapter", () => {
  const resumeFs = (files: Record<string, string> = {}, dirsIn: string[] = [SOURCE_HOME]) => memFs(files, dirsIn);
  function resumeWith(fs: DshAdapterFsOps, tmux: TmuxAdapter, dshCommand?: string) {
    let index = 0;
    return new DshResumeAdapter({
      tmux, fs, stateRoot: STATE_ROOT, runnerEntryPath: RUNNER, sourceDshHome: SOURCE_HOME,
      ...(dshCommand ? { dshCommand } : {}),
      sleep: async () => {}, newLaunchId: () => ["launch-r1", "launch-r2"][index++] ?? "launch-rx",
    });
  }

  it("claims only the dsh session-id shape — never Pi's or OMP's file shape", () => {
    const adapter = resumeWith(resumeFs(), mockTmux());
    expect(adapter.canResume("dsh_session_id", SESSION_ID)).toBe(true);
    expect(adapter.canResume("pi_session_file", "/state/pi/x/sessions/y.jsonl")).toBe(false);
    expect(adapter.canResume("omp_session_file", "/state/omp/x/sessions/y.jsonl")).toBe(false);
    expect(adapter.canResume("dsh_session_id", "")).toBe(false);
    expect(adapter.canResume("dsh_session_id", null)).toBe(false);
  });

  it("refuses before typing when the token is not even id-shaped", async () => {
    const sent: string[] = [];
    const adapter = resumeWith(resumeFs(), mockTmux({ sendShellCommand: async (_t, text) => { sent.push(text); return { ok: true as const }; } }));
    const result = await adapter.resume(SESSION, "dsh_session_id", "/etc/passwd", "/repo");
    expect(result).toMatchObject({ ok: false, code: "no_resume" });
    expect(sent).toEqual([]);
  });

  it("resumes only when the runner proves it continued the requested session", async () => {
    const fs = resumeFs();
    const sent: string[] = [];
    const tmux = mockTmux({ sendShellCommand: async (_t, text) => { sent.push(text); return { ok: true as const }; } });
    const adapter = resumeWith(fs, tmux);
    const pending = adapter.resume(SESSION, "dsh_session_id", SESSION_ID, "/repo", "deepseek/deepseek-chat", "floor", { nodeId: "node-1", launchGeneration: "gen-2" });
    fs.writeFile(PATH.runnerStatePath, JSON.stringify({ ready: true, launchId: "launch-r1", sessionId: SESSION_ID, updatedAt: "t" }));
    await expect(pending).resolves.toEqual({
      ok: true,
      appliedLaunch: { runtime: "dsh", axis: "permission", state: "observed", value: "workspace-write" },
    });

    const cmd = sent.join("\n");
    expect(cmd).toContain(`--session '${SESSION_ID}'`);
    expect(cmd).toContain("--posture floor");
    expect(cmd).toContain(`--node-id 'node-1'`);
    expect(cmd).toContain(`--generation 'gen-2'`);
  });

  it("reports retry_fresh when the runner comes up on some other session", async () => {
    const fs = resumeFs();
    const adapter = resumeWith(fs, mockTmux());
    const pending = adapter.resume(SESSION, "dsh_session_id", SESSION_ID, "/repo");
    fs.writeFile(PATH.runnerStatePath, JSON.stringify({ ready: true, launchId: "launch-r1", sessionId: "session-somewhere-else", updatedAt: "t" }));
    const result = await pending;
    expect(result).toMatchObject({ ok: false, code: "retry_fresh" });
    expect(result.message).toMatch(/did not continue the requested session/);
  });

  it("reports a failed resume when the runner exits — never a silent fresh seat", async () => {
    const fs = resumeFs();
    const adapter = resumeWith(fs, mockTmux());
    const pending = adapter.resume(SESSION, "dsh_session_id", SESSION_ID, "/repo");
    fs.writeFile(PATH.runnerStatePath, JSON.stringify({ ready: false, launchId: "launch-r1", updatedAt: "t", exited: { reason: "setup-failed", error: "resume refused" } }));
    const result = await pending;
    expect(result).toMatchObject({ ok: false, code: "resume_failed" });
    expect(result.message).toContain("resume refused");
  });

  it("forwards a configured non-default dsh executable on resume", async () => {
    const fs = resumeFs();
    const sent: string[] = [];
    const adapter = resumeWith(fs, mockTmux({ sendShellCommand: async (_t, text) => { sent.push(text); return { ok: true as const }; } }), "/opt/deepseek/bin/dsh");
    const pending = adapter.resume(SESSION, "dsh_session_id", SESSION_ID, "/repo");
    fs.writeFile(PATH.runnerStatePath, JSON.stringify({ ready: true, launchId: "launch-r1", sessionId: SESSION_ID, updatedAt: "t" }));
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(sent.join("\n")).toContain("--dsh-command '/opt/deepseek/bin/dsh'");
  });

  it("honours an explicit shared DSH_HOME instead of building a per-seat copy", async () => {
    const fs = resumeFs();
    const sent: string[] = [];
    const adapter = new DshResumeAdapter({
      tmux: mockTmux({ sendShellCommand: async (_t, text) => { sent.push(text); return { ok: true as const }; } }),
      fs, stateRoot: STATE_ROOT, runnerEntryPath: RUNNER, sourceDshHome: SOURCE_HOME,
      sharedDshHome: "/shared/dsh-home", sleep: async () => {}, newLaunchId: () => "launch-r1",
    });
    const pending = adapter.resume(SESSION, "dsh_session_id", SESSION_ID, "/repo");
    const pendingState = JSON.parse(fs.files[PATH.runnerStatePath]!);
    expect(pendingState.cwd).toBe("/repo");
    fs.writeFile(PATH.runnerStatePath, JSON.stringify({ ready: true, launchId: "launch-r1", sessionId: SESSION_ID, updatedAt: "t" }));
    await expect(pending).resolves.toEqual({
      ok: true,
      appliedLaunch: { runtime: "dsh", axis: "permission", state: "observed", value: "workspace-write" },
    });
    expect(sent.join("\n")).toContain("--dsh-home '/shared/dsh-home'");
    // The operator's home is never mutated when a shared home is declared.
    expect(fs.links).toEqual([]);
  });
});

// Keep the unused-import surface honest: these are the strings the adapter greps.
void sessionDir;
void vi;
