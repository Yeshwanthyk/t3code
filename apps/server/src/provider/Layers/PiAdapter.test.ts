// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { extractPiReplayContent, makePiAdapter } from "./PiAdapter.ts";

const dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgent = NodePath.join(dirname, "../../../scripts/pi-rpc-mock-agent.ts");
const TestLayer = ServerConfig.layerTest(process.cwd(), "pi-adapter-test").pipe(
  Layer.provideMerge(NodeServices.layer),
);

describe("PiAdapter replay", () => {
  it("projects only durable assistant content with stable indexes", () => {
    expect(
      extractPiReplayContent({
        type: "message",
        id: "entry-1",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "considering" },
            { type: "text", text: "done" },
            { type: "toolCall", id: "tool-1" },
          ],
        },
      }),
    ).toEqual([
      { kind: "reasoning", text: "considering", contentIndex: 0 },
      { kind: "assistant", text: "done", contentIndex: 1 },
    ]);
    expect(
      extractPiReplayContent({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "ignore" }] },
      }),
    ).toEqual([]);
  });

  effectIt.effect("rejects non-full-access mode before spawning Pi", () =>
    Effect.gen(function* () {
      const adapter = yield* makePiAdapter(
        { enabled: true, binaryPath: "/definitely/not/pi" },
        { instanceId: ProviderInstanceId.make("pi-test") },
      );
      const started = yield* Effect.exit(
        adapter.startSession({
          threadId: ThreadId.make("pi-rejected"),
          providerInstanceId: ProviderInstanceId.make("pi-test"),
          runtimeMode: "approval-required",
        }),
      );
      expect(started._tag).toBe("Failure");
      if (started._tag === "Failure") {
        expect(String(started.cause)).toContain("full-access");
      }
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  effectIt.effect("keeps agent_end non-terminal and completes only on agent_settled", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("pi-test");
      const threadId = ThreadId.make("pi-settled");
      const adapter = yield* makePiAdapter(
        { enabled: true, binaryPath: "node" },
        {
          instanceId,
          rpcArgs: [mockAgent],
          environment: {
            ...process.env,
            PI_MOCK_HOLD_SETTLE: "1",
            PI_MOCK_FRESH_EMPTY: "1",
          },
        },
      );
      yield* adapter.startSession({
        threadId,
        providerInstanceId: instanceId,
        runtimeMode: "full-access",
      });
      // Remove session.started and thread.started from the queue.
      yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2));

      const first = yield* adapter.sendTurn({ threadId, input: "first" });
      const started = yield* Stream.runHead(
        Stream.filter(adapter.streamEvents, (event) => event.type === "turn.started"),
      );
      expect(started._tag).toBe("Some");
      const running = (yield* adapter.listSessions())[0];
      expect(running?.activeTurnId).toBe(first.turnId);
      expect(running?.status).toBe("running");

      const completion = yield* Stream.runHead(
        Stream.filter(adapter.streamEvents, (event) => event.type === "turn.completed"),
      ).pipe(Effect.forkChild);
      yield* adapter.sendTurn({ threadId, input: "release settlement" });
      const completed = yield* Fiber.join(completion);
      expect(completed._tag).toBe("Some");
      const ready = (yield* adapter.listSessions())[0];
      expect(ready?.activeTurnId).toBeUndefined();
      expect(ready?.status).toBe("ready");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
