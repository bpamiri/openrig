// F10(a) — the ACP NDJSON client is the IPC plumbing the blockers live in. These
// drive a fake child through the client's injected spawn seam: framing, unknown
// ids, server requests, timeouts, exit and the resume result shape, with no dsh.

import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { AcpClient, AcpError } from "../src/adapters/dsh-runner.js";

function fakeChild() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout, stderr, stdin, exitCode: null as number | null,
    kill: vi.fn(),
  });
  let written = "";
  stdin.on("data", (chunk) => { written += chunk.toString(); });
  return { child, written: () => written };
}

function makeClient(c = fakeChild()) {
  const client = new AcpClient({
    command: "dsh", args: ["--profile", "acp"], cwd: "/repo", env: {},
    spawn: (() => c.child) as unknown as typeof import("node:child_process").spawn,
  });
  const stdout: string[] = [];
  client.on("stdout", ({ line }) => stdout.push(line));
  client.start();
  return { client, ...c, stdout };
}

const frame = (value: unknown) => `${JSON.stringify(value)}\n`;

describe("AcpClient framing", () => {
  it("writes one NDJSON line per request and settles by numeric id", async () => {
    const c = fakeChild();
    const client = new AcpClient({
      command: "dsh", args: [], cwd: "/repo", env: {},
      spawn: (() => c.child) as unknown as typeof import("node:child_process").spawn,
    });
    client.start();
    const pending = client.request("session/new", { cwd: "/repo", mcpServers: [] });
    const sent = JSON.parse(c.written().trim()) as Record<string, unknown>;
    expect(sent).toMatchObject({ jsonrpc: "2.0", method: "session/new", params: { cwd: "/repo" } });
    expect(typeof sent["id"]).toBe("number");
    c.child.stdout.write(frame({ jsonrpc: "2.0", id: sent["id"], result: { sessionId: "abc" } }));
    await expect(pending).resolves.toEqual({ sessionId: "abc" });
  });

  it("reassembles a frame split across arbitrary stdout chunks", async () => {
    const c = makeClient();
    const pending = c.client.request("initialize", {});
    const id = (JSON.parse(c.written().trim()) as { id: number }).id;
    const line = JSON.stringify({ jsonrpc: "2.0", id, result: { protocolVersion: 1 } });
    for (const char of line) c.child.stdout.write(char);
    c.child.stdout.write("\n");
    await expect(pending).resolves.toEqual({ protocolVersion: 1 });
  });

  it("surfaces a non-JSON line as stdout noise, never as protocol", () => {
    const c = makeClient();
    c.child.stdout.write("not json at all\n");
    expect(c.stdout).toEqual(["not json at all"]);
  });

  it("surfaces a response for an unknown id as stdout noise", () => {
    const c = makeClient();
    c.child.stdout.write(frame({ jsonrpc: "2.0", id: 999, result: {} }));
    expect(c.stdout.join("\n")).toContain('"id":999');
  });

  it("answers a server request exactly once even if the handler responds twice", () => {
    const c = makeClient();
    const respond = vi.fn<(result: unknown) => void>();
    c.client.on("request", ({ method, respond: respondOnce }) => {
      expect(method).toBe("session/request_permission");
      respondOnce({ outcome: { outcome: "cancelled" } });
      respondOnce({ outcome: { outcome: "selected" } });
      respond();
    });
    const id = 41;
    c.child.stdout.write(frame({ jsonrpc: "2.0", id, method: "session/request_permission", params: {} }));
    expect(respond).toHaveBeenCalled();
    const lines = c.written().trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
  });

  it("rejects a request at its timeout bound instead of waiting forever", async () => {
    const c = makeClient();
    await expect(c.client.request("session/new", {}, { timeoutMs: 20 })).rejects.toBeInstanceOf(AcpError);
  });

  it("rejects every pending request when the child exits", async () => {
    const c = makeClient();
    const pending = c.client.request("session/new", {});
    c.child.exitCode = 1;
    c.child.emit("exit", 1, null);
    await expect(pending).rejects.toThrow(/dsh exited/);
    expect(c.client.alive).toBe(false);
  });

  it("reports dsh's resume result shape honestly: configOptions, no fabricated reported id", async () => {
    const c = makeClient();
    const pending = c.client.resumeSession({ sessionId: "requested-id", cwd: "/repo", mcpServers: [] });
    const id = (JSON.parse(c.written().trim()) as { id: number }).id;
    c.child.stdout.write(frame({ jsonrpc: "2.0", id, result: { configOptions: [{ id: "model", options: [] }] } }));
    await expect(pending).resolves.toMatchObject({ sessionId: "requested-id", sessionIdReported: false });
  });
});
