// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import { makePiSessionRuntime, parsePiModelSlug, parsePiSessionState } from "./PiSessionRuntime.ts";

const dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgent = NodePath.join(dirname, "../../../scripts/pi-rpc-mock-agent.ts");

describe("PiSessionRuntime", () => {
  it.effect("decodes the durable native session identity", () =>
    Effect.gen(function* () {
      const state = yield* parsePiSessionState({
        sessionId: "session-1",
        sessionFile: "/tmp/session-1.jsonl",
        model: {
          provider: "anthropic",
          id: "claude-sonnet",
          name: "Claude Sonnet",
          reasoning: true,
          input: ["text", "image"],
        },
        thinkingLevel: "high",
        isStreaming: false,
      });
      expect(state.sessionId).toBe("session-1");
      expect(state.model?.provider).toBe("anthropic");
      expect(state.thinkingLevel).toBe("high");
    }),
  );

  it("requires provider/model identifiers", () => {
    expect(parsePiModelSlug("anthropic/claude-sonnet")).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet",
    });
    expect(parsePiModelSlug("claude-sonnet")).toBeNull();
  });

  it.effect("switches, verifies identity, and advances the durable entry cursor", () =>
    Effect.gen(function* () {
      const runtime = yield* makePiSessionRuntime({
        binaryPath: "node",
        cwd: process.cwd(),
        rpcArgs: [mockAgent],
        resumeCursor: {
          version: 1,
          sessionId: "resumed-session",
          sessionFile: "/tmp/pi-resumed.jsonl",
          lastEntryId: "entry-1",
        },
      });
      const replay = yield* runtime.reconcile("entry-1");
      expect(replay.entries.map((entry) => entry.id)).toEqual(["entry-2"]);
      expect(replay.cursor).toEqual({
        version: 1,
        sessionId: "resumed-session",
        sessionFile: "/tmp/pi-resumed.jsonl",
        lastEntryId: "entry-2",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails closed when Pi clamps the requested thinking level", () =>
    Effect.gen(function* () {
      const runtime = yield* makePiSessionRuntime({
        binaryPath: "node",
        cwd: process.cwd(),
        rpcArgs: [mockAgent],
        environment: { ...process.env, PI_MOCK_THINKING_APPLIED: "low" },
      });
      expect((yield* Effect.exit(runtime.setThinkingLevel("max")))._tag).toBe("Failure");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
