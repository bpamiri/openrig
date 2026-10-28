import { describe, expect, it } from "vitest";
import { deriveResumeToken } from "../src/domain/resume-token-capture.js";

const sessionName = "qa-worker@dsh-rig";
const sessionId = "session-4f7c2d1e-8a5b-4c3d-9e2f-6a1b0c9d8e7f";

describe("dsh adoption resume token capture", () => {
  it("reads the dsh runner sidecar's ACP session id and never a Pi/OMP session file", async () => {
    const result = await deriveResumeToken(
      { runtime: "dsh", sessionName },
      {
        dshRunnerStateStore: { readSessionId: (name) => {
          expect(name).toBe(sessionName);
          return { ok: true, sessionId };
        } },
        piRunnerStateStore: { readSessionFile: () => { throw new Error("Pi sidecar must not be read"); } },
        ompRunnerStateStore: { readSessionFile: () => { throw new Error("OMP sidecar must not be read"); } },
      },
    );
    expect(result).toEqual({ outcome: "captured", resumeType: "dsh_session_id", token: sessionId });
  });

  it("is a silent no-op when the dsh sidecar reader isn't wired", async () => {
    await expect(deriveResumeToken({ runtime: "dsh", sessionName }, {})).resolves.toEqual({ outcome: "noop" });
  });

  it("skips an absent sidecar as missing_sidecar and an unreadable one as parse_error", async () => {
    await expect(deriveResumeToken({ runtime: "dsh", sessionName }, {
      dshRunnerStateStore: { readSessionId: () => ({ ok: false, reason: "missing_sidecar" }) },
    })).resolves.toEqual({ outcome: "skipped", reason: "missing_sidecar" });
    await expect(deriveResumeToken({ runtime: "dsh", sessionName }, {
      dshRunnerStateStore: { readSessionId: () => ({ ok: false, reason: "parse_error" }) },
    })).resolves.toEqual({ outcome: "skipped", reason: "parse_error" });
  });

  it("refuses a malformed dsh token instead of persisting it", async () => {
    const result = await deriveResumeToken(
      { runtime: "dsh", sessionName },
      { dshRunnerStateStore: { readSessionId: () => ({ ok: true, sessionId: "../../etc/passwd" }) } },
    );
    expect(result).toEqual({ outcome: "skipped", reason: "invalid_token" });
  });
});
