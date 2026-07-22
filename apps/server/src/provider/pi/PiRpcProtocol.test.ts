// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

import {
  PiRpcBoundedStderr,
  PiRpcRecordDecoder,
  decodePiResumeCursor,
  decodePiRpcOutputRecord,
  routePiRpcOutputRecord,
  serializePiRpcInputRecord,
} from "./PiRpcProtocol.ts";

const fixtureDirectory = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "__fixtures__",
);

function readFixture(name: string): Uint8Array {
  return NodeFS.readFileSync(NodePath.join(fixtureDirectory, name));
}

function decodeFixture(name: string) {
  const source = readFixture(name);
  const decoder = new PiRpcRecordDecoder();
  const frames = [];
  for (let offset = 0; offset < source.byteLength; offset += 7) {
    frames.push(...decoder.push(source.subarray(offset, offset + 7)));
  }
  frames.push(...decoder.finish());
  return frames;
}

describe("PiRpcRecordDecoder", () => {
  it("decodes every documented fixture across arbitrary chunk boundaries", () => {
    for (const fixture of [
      "startup-state.stdout.jsonl",
      "resume-replay.stdout.jsonl",
      "turn-stream.stdout.jsonl",
      "controls-ui.stdout.jsonl",
    ]) {
      const frames = decodeFixture(fixture);
      expect(frames.length).toBeGreaterThan(0);
      for (const frame of frames) {
        expect(frame.ok).toBe(true);
        if (frame.ok) {
          expect(decodePiRpcOutputRecord(frame.value)).toMatchObject({ ok: true });
        }
      }
    }
  });

  it("uses LF only and preserves Unicode line separators inside JSON strings", () => {
    const separatorText = `before${String.fromCharCode(0x2028)}middle${String.fromCharCode(
      0x2029,
    )}after`;
    const decoder = new PiRpcRecordDecoder();
    const frames = decoder.push(`${JSON.stringify({ value: separatorText })}\r\n`);

    expect(frames).toEqual([{ ok: true, value: { value: separatorText }, byteLength: 36 }]);
  });

  it("fails an oversized record once, discards through LF, and resumes at the next record", () => {
    const decoder = new PiRpcRecordDecoder({ maxRecordBytes: 16 });
    const oversized = readFixture("oversized.stdout.jsonl");
    const frames = [...decoder.push(oversized), ...decoder.push('{"ok":true}\n')];

    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ ok: false, error: { code: "record_too_large" } });
    expect(frames[1]).toEqual({ ok: true, value: { ok: true }, byteLength: 11 });
  });

  it("reports malformed JSON and invalid UTF-8 without throwing", () => {
    const decoder = new PiRpcRecordDecoder();
    const malformed = decoder.push(readFixture("malformed.stdout.jsonl"));
    const invalidUtf8 = decoder.push(Uint8Array.from([0x7b, 0xff, 0x7d, 0x0a]));

    expect(malformed[0]).toMatchObject({ ok: false, error: { code: "invalid_json" } });
    expect(invalidUtf8[0]).toMatchObject({ ok: false, error: { code: "invalid_utf8" } });
  });

  it("accepts a final record at EOF like Pi's own strict reader", () => {
    const decoder = new PiRpcRecordDecoder();
    expect(decoder.push('{"type":"agent_settled"}')).toEqual([]);
    expect(decoder.finish()).toEqual([
      { ok: true, value: { type: "agent_settled" }, byteLength: 24 },
    ]);
  });
});

describe("Pi RPC envelopes", () => {
  it("routes correlated responses independently from events", () => {
    const response = decodePiRpcOutputRecord({
      id: "req-1",
      type: "response",
      command: "prompt",
      success: true,
    });
    const event = decodePiRpcOutputRecord({ type: "agent_settled" });

    expect(response.ok).toBe(true);
    expect(event.ok).toBe(true);
    if (response.ok && event.ok) {
      expect(routePiRpcOutputRecord(response.record)).toMatchObject({
        kind: "response",
        requestId: "req-1",
      });
      expect(routePiRpcOutputRecord(event.record)).toMatchObject({ kind: "event" });
    }
  });

  it("surfaces uncorrelated responses instead of confusing them with events", () => {
    const decoded = decodePiRpcOutputRecord({
      type: "response",
      command: "parse",
      success: false,
      error: "redacted parse error",
    });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(routePiRpcOutputRecord(decoded.record)).toMatchObject({
        kind: "uncorrelated_response",
      });
    }
  });

  it("rejects undocumented event types rather than inventing a contract", () => {
    expect(
      decodePiRpcOutputRecord({ type: "subagent_spawn", childSessionId: "child-redacted" }),
    ).toEqual({
      ok: false,
      error: {
        code: "unsupported_record_type",
        message: "Unsupported or unproven Pi RPC output type: subagent_spawn",
        recordType: "subagent_spawn",
      },
    });
  });

  it("serializes one bounded LF-terminated command record", () => {
    const encoded = serializePiRpcInputRecord({
      id: "req-1",
      type: "prompt",
      message: "line one\nline two",
    });
    expect(encoded).toBe('{"id":"req-1","type":"prompt","message":"line one\\nline two"}\n');
    expect(() =>
      serializePiRpcInputRecord(
        { id: "req-2", type: "prompt", message: "too large" },
        { maxRecordBytes: 8 },
      ),
    ).toThrow("exceeded 8 bytes");
  });
});

describe("Pi resume cursor", () => {
  it("requires versioned native session identity and allows an empty-session cursor", () => {
    const decoded = decodePiResumeCursor({
      version: 1,
      sessionId: "session-a",
      sessionFile: "/redacted/pi/sessions/session-a.jsonl",
      lastEntryId: null,
    });
    expect(decoded._tag).toBe("Success");
  });

  it("rejects unknown versions and incomplete identity", () => {
    expect(
      decodePiResumeCursor({
        version: 2,
        sessionId: "session-a",
        sessionFile: "/redacted/pi/sessions/session-a.jsonl",
        lastEntryId: "entry-1",
      })._tag,
    ).toBe("Failure");
    expect(
      decodePiResumeCursor({ version: 1, sessionId: "session-a", lastEntryId: "entry-1" })._tag,
    ).toBe("Failure");
  });
});

describe("PiRpcBoundedStderr", () => {
  it("keeps only bounded recent diagnostics and reports truncation", () => {
    const stderr = new PiRpcBoundedStderr({ maxBytes: 8 });
    stderr.append(readFixture("process-failure.stderr.txt"));

    expect(stderr.snapshot()).toEqual({
      text: "gnostic\n",
      totalBytes: 43,
      retainedBytes: 8,
      truncated: true,
    });
  });
});
