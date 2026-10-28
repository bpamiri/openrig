// OPR.0.6.DSH1 — the shared, PURE contract between the dsh runtime adapter, the
// dsh resume adapter, and the pane-hosted dsh-runner process.
//
// Everything here is side-effect-free (constants + string/argv/env builders +
// the runner-state sidecar shape) so the runner entry can import it without
// dragging daemon dependencies into the pane process, and the adapter/resume
// tests can assert command construction hermetically. Same rule as
// pi-runner-protocol.ts.
//
// Why dsh needs its own runner at all: dsh is protocol-first, OpenRig seats are
// tmux-first. `dsh tui` does not exist (`profile "tui" does not exist`); the
// shipped profiles are acp/web/headless/sdk/sdk-minimal. `headless` is one-shot
// (no mid-turn steering, no cancel) and `sdk` cannot resume. `acp` is the only
// dsh surface that is a seat: a persistent agent over NDJSON JSON-RPC on stdio
// with session/new, session/resume, session/list, session/close, session/cancel,
// session/set_config_option, session/prompt, session/update and
// session/request_permission.
//
// Contract summary:
// - The adapter launches `node <runnerEntry> …` inside the seat's tmux pane.
// - The runner spawns `dsh --profile acp` with a seat-scoped, WRITABLE DSH_HOME
//   and the posture's DSH_PERMISSION_MODE.
// - The runner persists `runner-state.json` (the sidecar) and prints the READY
//   marker to the pane; the daemon reads ONLY runner-authored surfaces — never
//   dsh UI heuristics, and never pane sampling.
// - Activity posts carry the seat's nodeId AND occupant generation, so the
//   daemon's occupant-tenure gate can trust them (issue #29 was this exact bug
//   on Pi).

import nodePath from "node:path";
import { shellQuote } from "./shell-quote.js";

/** dsh is its own runtime: unlike omp it does not reuse the Pi runner (dsh is
 *  not a Pi dialect), so this is a single-member union today and a documented
 *  seam for a future second ACP harness. */
export type DshRunnerRuntime = "dsh";

// ── Seat state layout ────────────────────────────────────────────────────────
// <stateRoot>/<sessionName>/dsh-home              → DSH_HOME for the seat (writable)
// <stateRoot>/<sessionName>/runner-state.json     → the runner's sidecar
//
// dsh has NO way to relocate its session logs: they live under DSH_HOME. So
// per-seat isolation of sessions means a per-seat DSH_HOME, and that is also
// what the writability requirement forces — dsh rewrites
// $DSH_HOME/profiles/<name>/cordis.yml on EVERY boot, so a seat pointed at the
// operator's own ~/.dsh would rewrite the profile tree their own dsh sessions
// are using.

export interface DshSeatPaths {
  seatRoot: string;
  /** The seat's private, writable DSH_HOME. */
  dshHome: string;
  runnerStatePath: string;
}

/** Keep a seat name usable as a single path segment. dsh's DSH_HOME has no
 *  opinion about it, but OpenRig session names legitimately contain `@`, `.`
 *  and `-`, and a name containing `/` or a traversal segment must never escape
 *  the state root. */
export function sanitizeDshSessionName(sessionName: string): string {
  const cleaned = sessionName.replace(/[^A-Za-z0-9._@-]+/g, "_");
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "dsh-seat" : cleaned;
}

export function dshSeatPaths(stateRoot: string, sessionName: string): DshSeatPaths {
  const seatRoot = nodePath.join(stateRoot, sanitizeDshSessionName(sessionName));
  return {
    seatRoot,
    dshHome: nodePath.join(seatRoot, "dsh-home"),
    runnerStatePath: nodePath.join(seatRoot, "runner-state.json"),
  };
}

// ── The seat's DSH_HOME ──────────────────────────────────────────────────────
// The home must be writable, and it must still find the profile's bundles. So
// the per-seat home is assembled the way dsh-seat/scripts/make-seat-home.sh does
// it: the profile directory is a real, writable COPY, and the shared NON-SECRET
// entries (the profile node_modules tree, .agent-presets) are SYMLINKED, never
// copied. The operator's `.credentials.yaml` is neither copied nor linked — see
// DSH_SEAT_HOME_LINK_ENTRIES.

/** Entries copied into a fresh seat home (writable, small, profile-specific). */
export const DSH_SEAT_HOME_COPY_ENTRIES = ["profiles"] as const;
/** Entries symlinked into a fresh seat home (shared, read-only, NON-SECRET).
 *
 *  `.credentials.yaml` is deliberately absent. It is not a provider key: it holds
 *  `records` (a browser-session secret) and `refs` for providers the seat may not
 *  use, and a symlink lets a full_bypass seat write through to the operator's
 *  store. Seats get credentials from the provider env allowlist
 *  (`DSH_PROVIDER_ENV_VARS`) instead; an operator who wants a stored-credential
 *  home can pass `OPENRIG_DSH_SHARED_HOME` (they own writability/isolation) or
 *  provision `.credentials.yaml` inside the seat home themselves. */
export const DSH_SEAT_HOME_LINK_ENTRIES = [".agent-presets", "settings.yaml.imported"] as const;
/** The operator credential store a seat must never inherit as a link. */
export const DSH_CREDENTIALS_FILE = ".credentials.yaml";
/** Setup-scoped request bound. Must stay below the adapter's 30 s readiness
 *  window: a wedged setup then ends with `setup-failed` before the launch gives
 *  up, and a slow-catalog operator can raise it (up to DSH_MAX_SETUP_TIMEOUT_MS)
 *  without widening the readiness window. */
export const DSH_DEFAULT_SETUP_TIMEOUT_MS = 20_000;
export const DSH_MAX_SETUP_TIMEOUT_MS = 29_000;

/** Resolve an explicit dependency or an environment value to a usable bound.
 *  Invalid values are ignored here; the adapters reject an invalid explicit
 *  dependency so a typo cannot silently fall back to the default. */
export function resolveDshSetupTimeoutMs(value: number | string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > DSH_MAX_SETUP_TIMEOUT_MS) return undefined;
  return Math.floor(parsed);
}
/** The one profile a managed seat runs. `dsh --profile acp`. */
export const DSH_DEFAULT_PROFILE = "acp";

/** What a provisioning pass has to be able to do. Kept as a narrow interface so
 *  the adapter can pass its injected fsOps and tests can pass a recorder. */
export interface DshHomeFsOps {
  exists(path: string): boolean;
  mkdirp(path: string): void;
  readDir(path: string): string[];
  copyFile(source: string, target: string): void;
  copyDir?(source: string, target: string): void;
  symlink(target: string, linkPath: string): void;
  /** Security migration for an older provisioning pass that symlinked the
   *  operator's credential store: detect and remove that link. Optional so a
   *  narrow test recorder still satisfies the interface. */
  isSymlink?(path: string): boolean;
  unlink?(path: string): void;
  /** Distinguishes a file from a directory so the profile copy can route each
   *  entry to the right operation. Absent = assume a file, which is the safe
   *  default: `copyFile` on a directory fails loudly rather than writing a file
   *  where a tree belongs. */
  statKind?(path: string): "file" | "directory";
}

export type DshHomeAction =
  | { kind: "linked-node-modules"; from: string; to: string }
  | { kind: "linked-entry"; entry: string; from: string; to: string }
  | { kind: "removed-credential-link"; entry: string; to: string }
  | { kind: "copied-profile"; from: string; to: string }
  | { kind: "skipped-profile-present"; to: string }
  | { kind: "skipped-no-source" | "skipped-same-home"; entry: string };

/** Provision (or adopt) a writable seat DSH_HOME from the operator's dsh home.
 *
 *  Idempotent: an existing profile copy is left alone, so a seat that already
 *  booted once keeps whatever dsh wrote into it. Returns what it actually did so
 *  a reviewer can see the writes rather than infer them.
 *
 *  R11: when sourceHome === seatHome the function is a no-op — a "copy profiles
 *  onto themselves" pass would recurse into the source it is reading. */
export function provisionDshSeatHome(
  fs: DshHomeFsOps,
  opts: { sourceHome: string; seatHome: string; profile?: string },
): DshHomeAction[] {
  const profile = opts.profile?.trim() || DSH_DEFAULT_PROFILE;
  const actions: DshHomeAction[] = [];
  if (nodePath.resolve(opts.sourceHome) === nodePath.resolve(opts.seatHome)) {
    return [{ kind: "skipped-same-home", entry: opts.seatHome }];
  }

  const sourceProfiles = nodePath.join(opts.sourceHome, "profiles");
  const seatProfiles = nodePath.join(opts.seatHome, "profiles");
  fs.mkdirp(seatProfiles);

  const sourceProfileDir = nodePath.join(sourceProfiles, profile);
  const seatProfileDir = nodePath.join(seatProfiles, profile);
  if (!fs.exists(sourceProfileDir)) {
    actions.push({ kind: "skipped-no-source", entry: `profiles/${profile}` });
  } else if (fs.exists(seatProfileDir)) {
    actions.push({ kind: "skipped-profile-present", to: seatProfileDir });
  } else {
    fs.mkdirp(seatProfileDir);
    for (const entry of fs.readDir(sourceProfileDir)) {
      const from = nodePath.join(sourceProfileDir, entry);
      const to = nodePath.join(seatProfileDir, entry);
      if (entry === "node_modules") {
        // The pnpm tree is huge and shared; dsh only reads it.
        fs.symlink(from, to);
        actions.push({ kind: "linked-node-modules", from, to });
        continue;
      }
      // A profile directory holds FILES (cordis.yml, package.json, …) beside
      // node_modules. Routing a file to copyDir would silently produce an empty
      // directory where dsh expects its config, so pick by kind.
      const kind = fs.statKind?.(from) ?? "file";
      if (kind === "directory" && fs.copyDir) fs.copyDir(from, to);
      else fs.copyFile(from, to);
    }
    actions.push({ kind: "copied-profile", from: sourceProfileDir, to: seatProfileDir });
  }

  const sharedNodeModules = nodePath.join(sourceProfiles, "node_modules");
  const seatNodeModules = nodePath.join(seatProfiles, "node_modules");
  if (fs.exists(sharedNodeModules) && !fs.exists(seatNodeModules)) {
    fs.symlink(sharedNodeModules, seatNodeModules);
    actions.push({ kind: "linked-node-modules", from: sharedNodeModules, to: seatNodeModules });
  }

  for (const entry of DSH_SEAT_HOME_LINK_ENTRIES) {
    const from = nodePath.join(opts.sourceHome, entry);
    const to = nodePath.join(opts.seatHome, entry);
    if (!fs.exists(from)) {
      actions.push({ kind: "skipped-no-source", entry });
      continue;
    }
    if (fs.exists(to)) continue;
    fs.symlink(from, to);
    actions.push({ kind: "linked-entry", entry, from, to });
  }

  // F6 security migration: an older provisioning pass symlinked the operator's
  // whole credential store into the seat. Never leave that in place, and never
  // replace it with anything derived from the store.
  const seatCredentials = nodePath.join(opts.seatHome, DSH_CREDENTIALS_FILE);
  // N-D: lstat only. `exists` follows the link, so a dangling credential link
  // (target deleted, link still pointing at the operator's store) would survive
  // and resolve again if the target came back.
  if (fs.isSymlink?.(seatCredentials) && fs.unlink) {
    fs.unlink(seatCredentials);
    actions.push({ kind: "removed-credential-link", entry: DSH_CREDENTIALS_FILE, to: seatCredentials });
  }

  return actions;
}

// ── Pane markers (runner-authored; the adapter greps for THESE) ──────────────

export const DSH_RUNNER_READY_MARKER = "[dsh-runner] READY";
export const DSH_RUNNER_EXIT_MARKER = "[dsh-runner] EXITED";
export const DSH_RUNNER_ERROR_MARKER = "[dsh-runner] ERROR";

// ── Posture → permission mode (the adapter's and the runner's shared table) ──

export const DSH_POSTURES = ["floor", "auto", "full_bypass"] as const;
export type DshPosture = (typeof DSH_POSTURES)[number];

export type DshPermissionMode = "workspace-write" | "danger-full-access";

/** Accept OpenRig's own posture vocabulary, plus the spellings a human or a
 *  rigspec may reasonably write. Throws on anything else rather than guessing a
 *  permission mode: a wrong guess here silently widens a seat's sandbox. */
export function normalizeDshPosture(value: string | null | undefined): DshPosture {
  const normalized = (value ?? "").trim().toLowerCase().replace(/-/g, "_");
  switch (normalized) {
    case "floor":
      return "floor";
    case "auto":
      return "auto";
    case "full_bypass":
    case "fullbypass":
    case "yolo":
    case "bypass":
      return "full_bypass";
    default:
      throw new Error(`unknown posture "${value}" (expected one of: ${DSH_POSTURES.join(", ")})`);
  }
}

/** dsh bundles sandbox + approval, and DSH_PERMISSION_MODE is the only
 *  launch-time selector it offers. Escalations still arrive as
 *  session/request_permission; this mode decides what the agent may do without
 *  asking, and the runner's posture decides what happens when it does ask. */
export function dshPermissionModeForPosture(posture: DshPosture): DshPermissionMode {
  return posture === "full_bypass" ? "danger-full-access" : "workspace-write";
}

// ── The runner-state sidecar ─────────────────────────────────────────────────

export interface DshRunnerExit {
  /** Why the seat ended: "user-quit" | "signal-SIGINT" | "stdin-closed" |
   *  "agent-exit code=<n> signal=<s>" | "setup-failed". */
  reason: string;
  /** Present when the reason carries an exit code; a signal path has none, so
   *  this is optional and NOT `number | null` (the Pi sidecar's shape would be
   *  a lie here). */
  code?: number;
  /** Setup-failure detail. */
  error?: string;
}

export interface DshRunnerState {
  ready: boolean;
  /** Launch-attempt scope: the adapter mints a launchId per attempt,
   *  pre-writes a pending sidecar carrying it, and passes --launch-id to the
   *  runner; the runner stamps it into every sidecar write. Readiness/resume
   *  polls IGNORE any state whose launchId differs, so a durable artifact from
   *  a prior runner instance can never false-green a new launch. */
  launchId?: string;
  sessionName?: string;
  cwd?: string;
  posture?: string;
  permissionMode?: string;
  /** The ACP session id dsh reported (a bare UUID; verified live on 0.2.1-rc.2
   *  and in 0.2.0-rc.2's source) — the resume token. */
  sessionId?: string | null;
  /** dsh deliberately has no session-file handle in the ACP surface; kept
   *  optional for shape parity with the Pi sidecar and for a future surface
   *  that reports one. */
  sessionFile?: string | null;
  runnerPid?: number;
  /** ISO timestamp of the last sidecar write. */
  updatedAt: string;
  exited?: DshRunnerExit | null;
}

/** The launch-scoped pending record the adapter pre-writes before it types
 *  anything. Nothing from the prior attempt survives: unlike the Pi runner's
 *  durable catch-up cursor, dsh has no equivalent consumer, so carrying stale
 *  fields forward would only be a way to be wrong. */
export function buildPendingDshRunnerState(
  launchId: string,
  updatedAt: string,
  identity: { sessionName?: string; cwd?: string; posture?: string; permissionMode?: string } = {},
): DshRunnerState {
  return {
    ready: false,
    launchId,
    sessionName: identity.sessionName,
    cwd: identity.cwd,
    posture: identity.posture,
    permissionMode: identity.permissionMode,
    sessionId: null,
    updatedAt,
    exited: null,
  };
}

/** Strict enough that a corrupt or foreign file cannot false-green checkReady. */
export function parseDshRunnerState(raw: string): DshRunnerState | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const state = parsed as Record<string, unknown>;
    if (typeof state.ready !== "boolean" || typeof state.updatedAt !== "string") return null;
    if (state.launchId !== undefined && typeof state.launchId !== "string") return null;
    if (state.sessionId !== undefined && state.sessionId !== null && typeof state.sessionId !== "string") return null;
    return parsed as DshRunnerState;
  } catch {
    return null;
  }
}

// ── Child environment (deny-by-default) ─────────────────────────────────────
// The Phase 1 runner handed dsh the runner's FULL environment plus DSH_HOME.
// That is ambient credential inheritance, and this repo's other pane-hosted
// runners deliberately do not do it (pi-runner-protocol.ts buildPiChildEnv).
// The managed seat gets an allowlist instead.

export const DSH_ENV_BASELINE_VARS = [
  "PATH", "HOME", "USER", "LOGNAME", "TERM", "LANG", "LC_ALL", "SHELL", "TMPDIR",
] as const;

/** Identity and instance routing. dsh's own shell tool inherits this child env,
 *  so dropping these makes ordinary `rig whoami` / `rig send` inside a seat
 *  resolve as an unmanaged caller or the wrong instance. Never synthesize
 *  identity, never forward arbitrary OPENRIG_* settings or the hook token. */
export const DSH_ENV_OPENRIG_VARS = [
  "OPENRIG_NODE_ID", "OPENRIG_SESSION_NAME", "OPENRIG_RUNTIME", "OPENRIG_OCCUPANT_GENERATION",
  "OPENRIG_HOME", "OPENRIG_URL", "OPENRIG_HOST", "OPENRIG_PORT", "OPENRIG_SHARED_DOCS_ROOT",
] as const;

/** Provider credentials dsh may need when a seat runs without a credentials
 *  file. dsh resolves providers through its own credential store and
 *  `$DSH_HOME/.credentials.yaml`; these are the env fallbacks its bundled
 *  providers read. Extending this map is a reviewed change, not a convenience
 *  edit — a key that crosses here is a credential every seat can read. */
export const DSH_PROVIDER_ENV_VARS: Record<string, string> = {
  deepseek: "DEEPSEEK_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

/** The provider segment of a `provider/id` model declaration, if any. */
export function dshProviderFromModel(model: string | undefined): string | null {
  const trimmed = model?.trim() ?? "";
  const slash = trimmed.indexOf("/");
  return slash > 0 ? trimmed.slice(0, slash) : null;
}

export function buildDshChildEnv(
  source: Record<string, string | undefined>,
  opts: { dshHome: string; permissionMode: DshPermissionMode; model?: string; sessionName?: string; nodeId?: string; generation?: string },
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [...DSH_ENV_BASELINE_VARS, ...DSH_ENV_OPENRIG_VARS]) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  // The seat's own identity wins over whatever was ambient.
  if (opts.sessionName) env.OPENRIG_SESSION_NAME = opts.sessionName;
  env.OPENRIG_RUNTIME = "dsh";
  if (opts.nodeId) env.OPENRIG_NODE_ID = opts.nodeId;
  if (opts.generation) env.OPENRIG_OCCUPANT_GENERATION = opts.generation;
  // dsh rewrites its profile config on every boot; this home must be writable.
  env.DSH_HOME = opts.dshHome;
  env.DSH_PERMISSION_MODE = opts.permissionMode;
  const provider = dshProviderFromModel(opts.model);
  const providerVar = provider ? DSH_PROVIDER_ENV_VARS[provider] : undefined;
  if (providerVar && source[providerVar] !== undefined) env[providerVar] = source[providerVar]!;
  return env;
}

// ── ACP config options (model / reasoning effort) ────────────────────────────
// dsh's model value is OPAQUE: `JSON.stringify([provider, model])` (verified live
// on 0.2.0-rc.2 and 0.2.1-rc.2). OpenRig's model field is `provider/model`, so the
// runner must map it against the choices dsh advertises in `session/new` /
// `session/resume` and fail BEFORE READY when it cannot.

export interface DshConfigChoice {
  /** The opaque value to send in `session/set_config_option`. */
  value: string;
  /** Human name from dsh (e.g. `deepseek-v4-flash`). */
  name?: string;
  description?: string;
}
export interface DshConfigOptionGroup {
  name?: string;
  description?: string;
  options?: readonly DshConfigNode[];
}
export type DshConfigNode = DshConfigChoice | DshConfigOptionGroup;

export interface DshConfigOption {
  id: string;
  name?: string;
  description?: string;
  currentValue?: string;
  options?: readonly DshConfigNode[];
}

export interface DshConfigSelection {
  configId: string;
  value: string;
  /** Human label for the pane/error surface; never a token. */
  label: string;
}

export type DshConfigResolution =
  | { ok: true; selections: DshConfigSelection[] }
  | { ok: false; error: string };

function isDshConfigChoice(node: DshConfigNode): node is DshConfigChoice {
  return typeof (node as DshConfigChoice).value === "string";
}

/** Flatten dsh's grouped choice tree into selectable values. dsh groups model
 *  choices (e.g. by provider), so a flat `options[].value` read misses them. */
export function flattenDshConfigChoices(option: DshConfigOption | null | undefined): DshConfigChoice[] {
  const choices: DshConfigChoice[] = [];
  const walk = (nodes: readonly DshConfigNode[] | undefined): void => {
    for (const node of nodes ?? []) {
      if (isDshConfigChoice(node)) {
        choices.push({ value: node.value, ...(node.name ? { name: node.name } : {}), ...(node.description ? { description: node.description } : {}) });
      } else walk(node.options);
    }
  };
  walk(option?.options);
  return choices;
}

/** Parse dsh's opaque selector value (`["provider","model"]`) into its tuple. */
export function parseDshConfigSelector(value: string): [string, string] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    if (typeof parsed[0] !== "string" || typeof parsed[1] !== "string") return null;
    if (!parsed[0].trim() || !parsed[1].trim()) return null;
    return [parsed[0], parsed[1]];
  } catch {
    return null;
  }
}

function choiceLabel(choice: DshConfigChoice): string {
  const tuple = parseDshConfigSelector(choice.value);
  return choice.name?.trim() || tuple?.[1] || choice.value;
}

function advertisedList(choices: readonly DshConfigChoice[]): string {
  return choices.map(choiceLabel).join(", ");
}

function resolveOneConfig(
  option: DshConfigOption | undefined,
  declared: string,
  configId: "model" | "reasoning_effort",
): { ok: true; choice: DshConfigChoice } | { ok: false; error: string } {
  if (!option) {
    return { ok: false, error: `${configId} "${declared}" is not available: dsh reported no ${configId} option in the session` };
  }
  const choices = flattenDshConfigChoices(option);
  if (choices.length === 0) {
    return { ok: false, error: `${configId} "${declared}" is not available: dsh offered no selectable ${configId} values` };
  }
  const lower = declared.toLowerCase();
  const direct = choices.find((choice) => choice.value === declared
    || choice.name?.trim().toLowerCase() === lower);
  if (direct) return { ok: true, choice: direct };

  if (configId === "model") {
    // An already-opaque selector is accepted only if dsh advertises exactly it.
    const declaredTuple = parseDshConfigSelector(declared);
    if (declaredTuple) {
      const exact = choices.find((choice) => {
        const tuple = parseDshConfigSelector(choice.value);
        return tuple?.[0] === declaredTuple[0] && tuple?.[1] === declaredTuple[1];
      });
      if (exact) return { ok: true, choice: exact };
      return { ok: false, error: `model "${declared}" is not available in this dsh profile; advertised: ${advertisedList(choices)}` };
    }
    const slash = declared.indexOf("/");
    const provider = slash > 0 ? declared.slice(0, slash) : "";
    const modelId = slash > 0 ? declared.slice(slash + 1) : declared;
    const byModel = choices.filter((choice) => {
      const tuple = parseDshConfigSelector(choice.value);
      return tuple ? tuple[1] === modelId : choice.name?.trim() === modelId;
    });
    if (byModel.length === 0) {
      return { ok: false, error: `model "${declared}" is not available in this dsh profile; advertised: ${advertisedList(choices)}` };
    }
    const byProvider = provider
      ? byModel.filter((choice) => {
        const tuple = parseDshConfigSelector(choice.value);
        if (!tuple) return false;
        const advertisedProvider = tuple[0].toLowerCase();
        const wantedProvider = provider.toLowerCase();
        return advertisedProvider === wantedProvider
          || advertisedProvider.includes(wantedProvider) || wantedProvider.includes(advertisedProvider);
      })
      : byModel;
    const chosen = byProvider.length === 1 ? byProvider[0] : byModel.length === 1 ? byModel[0] : undefined;
    if (chosen) return { ok: true, choice: chosen };
    return { ok: false, error: `model "${declared}" matches more than one dsh model; advertised: ${advertisedList(byModel)}` };
  }

  const caseInsensitive = choices.find((choice) => choice.value.toLowerCase() === lower);
  if (caseInsensitive) return { ok: true, choice: caseInsensitive };
  return { ok: false, error: `${configId} "${declared}" is not available in this dsh profile; advertised: ${advertisedList(choices)}` };
}

/** Map OpenRig's declared model/effort onto dsh's advertised selector values.
 *  A declared value that cannot be mapped is an error, never a fallback: the
 *  seat would otherwise run a model the rig did not ask for. */
export function resolveDshConfigSelections(
  configOptions: readonly DshConfigOption[] | null | undefined,
  declared: { model?: string | null; effort?: string | null },
): DshConfigResolution {
  const byId = new Map<string, DshConfigOption>();
  for (const option of configOptions ?? []) {
    if (typeof option?.id === "string") byId.set(option.id, option);
  }
  const selections: DshConfigSelection[] = [];
  const model = declared.model?.trim();
  if (model) {
    const resolved = resolveOneConfig(byId.get("model"), model, "model");
    if (!resolved.ok) return resolved;
    selections.push({ configId: "model", value: resolved.choice.value, label: choiceLabel(resolved.choice) });
  }
  const effort = declared.effort?.trim();
  if (effort) {
    const resolved = resolveOneConfig(byId.get("reasoning_effort"), effort, "reasoning_effort");
    if (!resolved.ok) return resolved;
    selections.push({ configId: "reasoning_effort", value: resolved.choice.value, label: choiceLabel(resolved.choice) });
  }
  return { ok: true, selections };
}

// ── Command construction ─────────────────────────────────────────────────────

export interface DshRunnerLaunchOpts {
  /** Absolute path to the compiled runner entry (daemon dist). */
  runnerEntryPath: string;
  /** The seat's canonical session name (identity + sidecar key). */
  sessionName: string;
  /** Seat state root (the <stateRoot> dshSeatPaths derives from). */
  stateRoot: string;
  /** The seat's writable DSH_HOME. */
  dshHome: string;
  /** Managed working directory for the dsh session (dsh requires absolute). */
  cwd: string;
  /** OpenRig's posture vocabulary. Always explicit — never inferred. */
  posture: DshPosture;
  /** dsh session id to resume. Mutually exclusive with a fresh launch. */
  sessionId?: string;
  /** Optional `provider/id` model declaration. */
  model?: string;
  effort?: string;
  /** OpenRig seat identity for activity posts (issue #29's fix). */
  nodeId?: string;
  generation?: string;
  /** Launch-attempt scope stamped into every runner sidecar write. */
  launchId: string;
  /** `dsh` executable the runner spawns. Defaults to `dsh` on the pane's PATH;
   *  a non-default value is forwarded as `--dsh-command` so the adapter's
   *  dshCommand option actually reaches the child. */
  dshCommand?: string;
  /** dsh profile the runner spawns. Defaults to `acp` (the runner's own
   *  default); a non-default value is forwarded as `--profile` so the profile
   *  provisioned into the seat home is the profile that actually boots. */
  profile?: string;
  /** Optional JSON file holding the ACP `mcpServers` array. */
  mcpServersFile?: string;
  /** Setup request bound (N-E). Non-default values are forwarded;
   *  the runner's default is DSH_DEFAULT_SETUP_TIMEOUT_MS. */
  setupTimeoutMs?: number;
}

/** The command typed into the seat's tmux pane. The runner owns everything past
 *  this boundary (dsh spawn, child env, ACP, mirror, sidecar, activity). */
export function buildDshRunnerCommand(opts: DshRunnerLaunchOpts): string {
  const parts = [
    "node",
    shellQuote(opts.runnerEntryPath),
    "--session-name", shellQuote(opts.sessionName),
    "--state-root", shellQuote(opts.stateRoot),
    "--dsh-home", shellQuote(opts.dshHome),
    "--cwd", shellQuote(opts.cwd),
    "--launch-id", shellQuote(opts.launchId),
    // Always explicit: the runner refuses to guess a posture.
    "--posture", opts.posture,
  ];
  if (opts.sessionId?.trim()) parts.push("--session", shellQuote(opts.sessionId.trim()));
  const dshCommand = opts.dshCommand?.trim();
  if (dshCommand && dshCommand !== "dsh") parts.push("--dsh-command", shellQuote(dshCommand));
  const profile = opts.profile?.trim();
  if (profile && profile !== DSH_DEFAULT_PROFILE) parts.push("--profile", shellQuote(profile));
  if (opts.setupTimeoutMs !== undefined && opts.setupTimeoutMs !== DSH_DEFAULT_SETUP_TIMEOUT_MS) {
    parts.push("--setup-timeout", String(opts.setupTimeoutMs));
  }
  if (opts.model?.trim()) parts.push("--model", shellQuote(opts.model.trim()));
  if (opts.effort?.trim()) parts.push("--effort", shellQuote(opts.effort.trim()));
  if (opts.nodeId?.trim()) parts.push("--node-id", shellQuote(opts.nodeId.trim()));
  if (opts.generation?.trim()) parts.push("--generation", shellQuote(opts.generation.trim()));
  if (opts.mcpServersFile?.trim()) parts.push("--mcp-servers", shellQuote(opts.mcpServersFile.trim()));
  return parts.join(" ");
}

/** Argv for the `dsh` child the RUNNER spawns (argv-style, no shell). */
export function buildDshChildArgs(opts: { profile?: string } = {}): string[] {
  return ["--profile", opts.profile?.trim() || DSH_DEFAULT_PROFILE];
}

// ── Resume-token redaction ───────────────────────────────────────────────────
// The repo's resume-token contract makes the token credential-class: it must
// never be quoted in an error, a sidecar, a log or the pane. dsh's own error text
// can contain the requested id, so scrub it before anything is written or shown.

export function redactDshSessionId(text: string, sessionId: string | null | undefined): string {
  const token = sessionId?.trim();
  if (!token) return text;
  return text.split(token).join("[redacted-session]");
}

// ── Resume token shape ───────────────────────────────────────────────────────
// A dsh session id is a bare UUID (`randomUUID()`, verified live on both
// 0.2.0-rc.2 and 0.2.1-rc.2): id-shaped, never a path. The resume
// surface is `session/resume {sessionId, cwd, mcpServers}`, and dsh refuses a
// session that is still active or whose cwd does not match exactly — which is
// why the adapter verifies the runner came back on the requested id rather than
// assuming the request was honoured.

export const DSH_RESUME_TYPE = "dsh_session_id" as const;
