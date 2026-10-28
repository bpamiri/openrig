// OPR.0.6.DSH1 — hermetic unit tests for the pure dsh contract: posture and
// permission-mode mapping, the seat state layout, the writable DSH_HOME
// provisioning pass, the sidecar parser, the child env allowlist and the runner
// argv contract. No dsh, no tmux, no network.

import { describe, it, expect } from "vitest";
import {
  DSH_DEFAULT_PROFILE, DSH_PROVIDER_ENV_VARS, DSH_RESUME_TYPE, DSH_RUNNER_ERROR_MARKER,
  DSH_RUNNER_EXIT_MARKER, DSH_RUNNER_READY_MARKER,
  buildDshChildArgs, buildDshChildEnv, buildDshRunnerCommand, buildPendingDshRunnerState,
  dshPermissionModeForPosture, dshProviderFromModel, dshSeatPaths, normalizeDshPosture,
  parseDshRunnerState, provisionDshSeatHome, redactDshSessionId, resolveDshConfigSelections,
  sanitizeDshSessionName,
  type DshHomeAction, type DshHomeFsOps,
} from "../src/adapters/dsh-runner-protocol.js";

const SESSION = "dev1-dsh@dsh-scratch";

describe("posture → DSH_PERMISSION_MODE", () => {
  it("maps OpenRig's three postures", () => {
    expect(dshPermissionModeForPosture("floor")).toBe("workspace-write");
    expect(dshPermissionModeForPosture("auto")).toBe("workspace-write");
    expect(dshPermissionModeForPosture("full_bypass")).toBe("danger-full-access");
  });

  it("accepts the spellings a rigspec or a human may write", () => {
    expect(normalizeDshPosture("floor")).toBe("floor");
    expect(normalizeDshPosture("FLOOR")).toBe("floor");
    expect(normalizeDshPosture("full-bypass")).toBe("full_bypass");
    expect(normalizeDshPosture("yolo")).toBe("full_bypass");
  });

  it("refuses read-only aliases instead of silently widening them to workspace-write", () => {
    expect(() => normalizeDshPosture("read-only")).toThrow(/unknown posture/);
    expect(() => normalizeDshPosture("readonly")).toThrow(/unknown posture/);
  });

  it("throws rather than guessing a permission mode", () => {
    expect(() => normalizeDshPosture("workspace-write")).toThrow(/unknown posture/);
    expect(() => normalizeDshPosture("")).toThrow(/unknown posture/);
    expect(() => normalizeDshPosture(null)).toThrow(/unknown posture/);
  });
});

describe("seat state layout", () => {
  it("roots the sidecar and the seat's DSH_HOME under one session directory", () => {
    const paths = dshSeatPaths("/state/dsh", SESSION);
    expect(paths.seatRoot).toBe(`/state/dsh/${SESSION}`);
    expect(paths.dshHome).toBe(`/state/dsh/${SESSION}/dsh-home`);
    expect(paths.runnerStatePath).toBe(`/state/dsh/${SESSION}/runner-state.json`);
  });

  it("keeps a seat name a single safe path segment", () => {
    expect(sanitizeDshSessionName(SESSION)).toBe(SESSION);
    expect(sanitizeDshSessionName("a/b")).toBe("a_b");
    expect(sanitizeDshSessionName("..")).toBe("dsh-seat");
    expect(sanitizeDshSessionName("")).toBe("dsh-seat");
    // A traversal segment must never escape the state root.
    expect(dshSeatPaths("/state/dsh", "../../etc").seatRoot).toBe("/state/dsh/.._.._etc");
  });
});

describe("writable seat DSH_HOME", () => {
  function recorder(existing: string[] = []) {
    const actions: DshHomeAction[] = [];
    const written: string[] = [];
    const links = new Set<string>();
    const fs: DshHomeFsOps = {
      exists: (p) => existing.includes(p) || links.has(p),
      mkdirp: (p) => { written.push(`mkdir ${p}`); },
      readDir: () => ["cordis.yml", "cordis.patch.yml", "package.json", "node_modules"],
      copyFile: (source, target) => { written.push(`copy ${source} -> ${target}`); },
      copyDir: (source, target) => { written.push(`copydir ${source} -> ${target}`); },
      symlink: (target, linkPath) => { written.push(`link ${linkPath} -> ${target}`); links.add(linkPath); },
      isSymlink: (p) => links.has(p),
      unlink: (p) => { written.push(`unlink ${p}`); links.delete(p); },
      statKind: (p) => (p.endsWith("node_modules") ? "directory" as const : "file" as const),
    };
    return { fs, actions, written, links };
  }

  it("copies the profile (writable) and links only NON-secret shared parts", () => {
    const { fs, written, links } = recorder([
      "/op/.dsh/profiles/acp",
      "/op/.dsh/profiles/acp/cordis.yml",
      "/op/.dsh/profiles/acp/node_modules",
      "/op/.dsh/profiles/node_modules",
      "/op/.dsh/.credentials.yaml",
      "/op/.dsh/.agent-presets",
    ]);
    const actions = provisionDshSeatHome(fs, { sourceHome: "/op/.dsh", seatHome: "/seat/dsh-home" });

    // dsh rewrites cordis.yml on every boot, so the profile's FILES must be real
    // copies (not links into the operator's home)…
    expect(written).toContain("copy /op/.dsh/profiles/acp/cordis.yml -> /seat/dsh-home/profiles/acp/cordis.yml");
    expect(written.some((w) => w.startsWith("copydir /op/.dsh/profiles/acp"))).toBe(false);
    // …while the heavy pnpm tree and non-secret presets are linked.
    expect(written).toContain("link /seat/dsh-home/profiles/acp/node_modules -> /op/.dsh/profiles/acp/node_modules");
    expect(written).toContain("link /seat/dsh-home/profiles/node_modules -> /op/.dsh/profiles/node_modules");
    expect(written).toContain("link /seat/dsh-home/.agent-presets -> /op/.dsh/.agent-presets");
    // F6: the operator credential store is never linked (nor copied).
    expect(written.some((w) => w.includes(".credentials.yaml"))).toBe(false);
    expect(links.has("/seat/dsh-home/.credentials.yaml")).toBe(false);
    expect(actions.some((a) => a.kind === "linked-entry" && a.entry === ".credentials.yaml")).toBe(false);
    expect(actions.some((a) => a.kind === "copied-profile")).toBe(true);
  });

  it("removes an older provisioning pass's credential-store symlink", () => {
    const { fs, links } = recorder([
      "/op/.dsh/profiles/acp",
      "/op/.dsh/.credentials.yaml",
    ]);
    // Simulate the pre-fix seat home: a symlink to the operator's whole store.
    links.add("/seat/dsh-home/.credentials.yaml");
    const result = provisionDshSeatHome(fs, { sourceHome: "/op/.dsh", seatHome: "/seat/dsh-home" });
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "removed-credential-link", entry: ".credentials.yaml" }),
    ]));
    expect(links.has("/seat/dsh-home/.credentials.yaml")).toBe(false);
  });

  it("adopts an existing seat home instead of re-copying over what dsh wrote", () => {
    const { fs, written } = recorder(["/op/.dsh/profiles/acp", "/seat/dsh-home/profiles/acp"]);
    const actions = provisionDshSeatHome(fs, { sourceHome: "/op/.dsh", seatHome: "/seat/dsh-home" });
    expect(actions.some((a) => a.kind === "skipped-profile-present")).toBe(true);
    expect(written.some((w) => w.includes("profiles/acp"))).toBe(false);
  });

  it("is a no-op when the source and the seat home are the same directory", () => {
    const { fs, written } = recorder(["/op/.dsh/profiles/acp"]);
    const actions = provisionDshSeatHome(fs, { sourceHome: "/op/.dsh", seatHome: "/op/.dsh" });
    expect(actions).toEqual([{ kind: "skipped-same-home", entry: "/op/.dsh" }]);
    expect(written).toEqual([]);
  });
});

describe("runner-state sidecar", () => {
  it("parses a sidecar the runner wrote and rejects anything that cannot be trusted", () => {
    expect(parseDshRunnerState(JSON.stringify({ ready: true, updatedAt: "t0" }))).toMatchObject({ ready: true });
    expect(parseDshRunnerState(JSON.stringify({ ready: false, updatedAt: "t0", launchId: "L1" }))).toMatchObject({ launchId: "L1" });
    expect(parseDshRunnerState("not json")).toBeNull();
    expect(parseDshRunnerState(JSON.stringify({ updatedAt: "t0" }))).toBeNull();
    expect(parseDshRunnerState(JSON.stringify({ ready: "yes", updatedAt: "t0" }))).toBeNull();
    expect(parseDshRunnerState(JSON.stringify({ ready: true, updatedAt: "t0", sessionId: 7 }))).toBeNull();
    expect(parseDshRunnerState(JSON.stringify([{ ready: true, updatedAt: "t0" }]))).toBeNull();
  });

  it("writes a pending record scoped to this launch attempt and nothing else", () => {
    const pending = buildPendingDshRunnerState("launch-9", "t0", { sessionName: SESSION, cwd: "/repo", posture: "floor" });
    expect(pending).toMatchObject({ ready: false, launchId: "launch-9", sessionId: null, exited: null, cwd: "/repo" });
  });
});

describe("dsh child env", () => {
  it("passes the seat's identity, a writable DSH_HOME and the posture's mode", () => {
    const env = buildDshChildEnv(
      { PATH: "/bin", HOME: "/h", OPENRIG_NODE_ID: "node-1", OPENRIG_ACTIVITY_HOOK_TOKEN: "secret", DEEPSEEK_API_KEY: "k" },
      { dshHome: "/seat/dsh-home", permissionMode: "workspace-write", model: "deepseek/deepseek-chat", sessionName: SESSION, nodeId: "node-1", generation: "gen-1" },
    );
    expect(env).toMatchObject({
      PATH: "/bin", HOME: "/h",
      DSH_HOME: "/seat/dsh-home", DSH_PERMISSION_MODE: "workspace-write",
      OPENRIG_NODE_ID: "node-1", OPENRIG_SESSION_NAME: SESSION,
      OPENRIG_RUNTIME: "dsh", OPENRIG_OCCUPANT_GENERATION: "gen-1",
      DEEPSEEK_API_KEY: "k",
    });
    // The runner's own hook credential is NOT the child's business.
    expect(env).not.toHaveProperty("OPENRIG_ACTIVITY_HOOK_TOKEN");
  });

  it("forwards only the declared provider's key, never an arbitrary one", () => {
    const env = buildDshChildEnv(
      { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" },
      { dshHome: "/h", permissionMode: "workspace-write", model: "deepseek/deepseek-chat" },
    );
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(DSH_PROVIDER_ENV_VARS["deepseek"]).toBe("DEEPSEEK_API_KEY");
  });

  it("reads the provider segment of a model declaration", () => {
    expect(dshProviderFromModel("deepseek/deepseek-chat")).toBe("deepseek");
    expect(dshProviderFromModel("openai-codex/gpt-5")).toBe("openai-codex");
    expect(dshProviderFromModel("bare-model")).toBeNull();
    expect(dshProviderFromModel(undefined)).toBeNull();
  });
});

describe("runner contract", () => {
  it("spawns the acp profile — the only dsh profile that is a seat", () => {
    expect(buildDshChildArgs()).toEqual(["--profile", DSH_DEFAULT_PROFILE]);
    expect(DSH_DEFAULT_PROFILE).toBe("acp");
    expect(buildDshChildArgs({ profile: "sdk" })).toEqual(["--profile", "sdk"]);
  });

  it("builds the pane command with every piece of seat identity", () => {
    const cmd = buildDshRunnerCommand({
      runnerEntryPath: "/d/adapters/dsh-runner.js",
      sessionName: SESSION,
      stateRoot: "/state/dsh",
      dshHome: "/state/dsh/seat/dsh-home",
      cwd: "/repo/with space",
      posture: "auto",
      sessionId: "session-abc",
      model: "deepseek/deepseek-chat",
      nodeId: "node-1",
      generation: "gen-1",
      launchId: "launch-1",
    });
    expect(cmd).toBe(
      "node '/d/adapters/dsh-runner.js' --session-name 'dev1-dsh@dsh-scratch'"
      + " --state-root '/state/dsh'"
      + " --dsh-home '/state/dsh/seat/dsh-home'"
      + " --cwd '/repo/with space'"
      + " --launch-id 'launch-1'"
      + " --posture auto"
      + " --session 'session-abc'"
      + " --model 'deepseek/deepseek-chat'"
      + " --node-id 'node-1'"
      + " --generation 'gen-1'",
    );
  });

  it("omits the optional flags on a fresh seat", () => {
    const cmd = buildDshRunnerCommand({
      runnerEntryPath: "/r.js", sessionName: "s", stateRoot: "/st", dshHome: "/h", cwd: "/c", posture: "floor", launchId: "L",
    });
    expect(cmd).toBe("node '/r.js' --session-name 's' --state-root '/st' --dsh-home '/h' --cwd '/c' --launch-id 'L' --posture floor");
  });

  it("forwards a non-default dsh profile and keeps the default command unchanged", () => {
    const base = {
      runnerEntryPath: "/r.js", sessionName: "s", stateRoot: "/st", dshHome: "/h", cwd: "/c",
      posture: "floor" as const, launchId: "L",
    };
    expect(buildDshRunnerCommand(base)).not.toContain("--profile");
    expect(buildDshRunnerCommand({ ...base, profile: "acp" })).not.toContain("--profile");
    expect(buildDshRunnerCommand({ ...base, profile: "custom-profile" })).toContain("--profile 'custom-profile'");
    expect(buildDshRunnerCommand({ ...base, effort: "high" })).toContain("--effort 'high'");
  });

  it("forwards a non-default dsh executable and keeps the default command unchanged", () => {
    const base = {
      runnerEntryPath: "/r.js", sessionName: "s", stateRoot: "/st", dshHome: "/h", cwd: "/c",
      posture: "floor" as const, launchId: "L",
    };
    expect(buildDshRunnerCommand(base)).not.toContain("--dsh-command");
    expect(buildDshRunnerCommand({ ...base, dshCommand: "dsh" })).not.toContain("--dsh-command");
    expect(buildDshRunnerCommand({ ...base, dshCommand: "/opt/deepseek/bin/dsh" }))
      .toContain("--dsh-command '/opt/deepseek/bin/dsh'");
  });

  it("names the markers and resume type the adapter greps for", () => {
    expect(DSH_RUNNER_READY_MARKER).toBe("[dsh-runner] READY");
    expect(DSH_RUNNER_EXIT_MARKER).toBe("[dsh-runner] EXITED");
    expect(DSH_RUNNER_ERROR_MARKER).toBe("[dsh-runner] ERROR");
    expect(DSH_RESUME_TYPE).toBe("dsh_session_id");
  });
});

describe("ACP model/effort selector mapping (F1)", () => {
  const ADVERTISED = [{
    id: "model",
    name: "Model",
    currentValue: JSON.stringify(["deepseek-official", "deepseek-v4-flash"]),
    options: [{
      name: "DeepSeek",
      options: [
        { value: JSON.stringify(["deepseek-official", "deepseek-v4-flash"]), name: "deepseek-v4-flash" },
        { value: JSON.stringify(["openrouter", "deepseek/deepseek-chat"]), name: "deepseek-chat" },
      ],
    }],
  }, {
    id: "reasoning_effort",
    options: [{ value: "low", name: "low" }, { value: "high", name: "high" }],
  }];

  it("maps OpenRig's provider/model to dsh's opaque JSON selector, never the raw string", () => {
    const resolved = resolveDshConfigSelections(ADVERTISED, { model: "openrouter/deepseek/deepseek-chat" });
    expect(resolved).toEqual({
      ok: true,
      selections: [{ configId: "model", value: JSON.stringify(["openrouter", "deepseek/deepseek-chat"]), label: "deepseek-chat" }],
    });
    if (resolved.ok) expect(JSON.parse(resolved.selections[0]!.value)).toEqual(["openrouter", "deepseek/deepseek-chat"]);
  });

  it("prefers the matching provider when the model id exists under more than one", () => {
    const resolved = resolveDshConfigSelections(ADVERTISED, { model: "deepseek-official/deepseek-v4-flash" });
    expect(resolved).toMatchObject({ ok: true, selections: [{ value: JSON.stringify(["deepseek-official", "deepseek-v4-flash"]) }] });
  });

  it("accepts an exact opaque selector only when dsh advertises it", () => {
    expect(resolveDshConfigSelections(ADVERTISED, { model: JSON.stringify(["deepseek-official", "deepseek-v4-flash"]) }))
      .toMatchObject({ ok: true });
    expect(resolveDshConfigSelections(ADVERTISED, { model: JSON.stringify(["nope", "nope"]) }))
      .toMatchObject({ ok: false, error: expect.stringContaining("advertised") });
  });

  it("fails before READY, listing advertised names, when a declared model cannot be mapped", () => {
    const resolved = resolveDshConfigSelections(ADVERTISED, { model: "deepseek/deepseek-chat" });
    expect(resolved).toMatchObject({ ok: false });
    if (!resolved.ok) {
      expect(resolved.error).toContain("not available");
      expect(resolved.error).toMatch(/deepseek-v4-flash|deepseek-chat/);
    }
    expect(resolveDshConfigSelections([], { model: "deepseek/deepseek-chat" }))
      .toMatchObject({ ok: false, error: expect.stringContaining("no model option") });
  });

  it("maps reasoning_effort and refuses an unadvertised level", () => {
    expect(resolveDshConfigSelections(ADVERTISED, { effort: "HIGH" }))
      .toMatchObject({ ok: true, selections: [{ configId: "reasoning_effort", value: "high" }] });
    expect(resolveDshConfigSelections(ADVERTISED, { effort: "max" }))
      .toMatchObject({ ok: false, error: expect.stringContaining("advertised") });
  });
});

describe("resume-token redaction (F11)", () => {
  it("scrubs the requested session id and leaves ordinary text alone", () => {
    expect(redactDshSessionId("session 4f7b4d71-0fd8-4b73-a3db-893692e6375c is not resumable", "4f7b4d71-0fd8-4b73-a3db-893692e6375c"))
      .toBe("session [redacted-session] is not resumable");
    expect(redactDshSessionId("plain failure", "4f7b4d71-0fd8-4b73-a3db-893692e6375c")).toBe("plain failure");
    expect(redactDshSessionId("same", null)).toBe("same");
  });
});
