// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { makePiRpcProcess } from "./PiRpcProcess.ts";

const dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgent = NodePath.join(dirname, "../../../scripts/pi-rpc-mock-agent.ts");

describe("PiRpcProcess", () => {
  it.effect("correlates responses while independently streaming events", () =>
    Effect.gen(function* () {
      const rpc = yield* makePiRpcProcess({
        binaryPath: "node",
        cwd: process.cwd(),
        rpcArgs: [mockAgent],
      });
      const collected = yield* Stream.runCollect(Stream.take(rpc.events, 4)).pipe(Effect.forkChild);
      const response = yield* rpc.request({ type: "prompt", message: "hi" });
      expect(response.command).toBe("prompt");
      expect(response.success).toBe(true);
      expect(Array.from(yield* Fiber.join(collected)).map((event) => event.type)).toEqual([
        "agent_start",
        "message_update",
        "agent_end",
        "agent_settled",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects an outstanding command when the child exits", () =>
    Effect.gen(function* () {
      const rpc = yield* makePiRpcProcess({
        binaryPath: "node",
        cwd: process.cwd(),
        rpcArgs: [mockAgent],
        environment: { ...process.env, PI_MOCK_EXIT_ON_ABORT: "1" },
      });
      expect((yield* Effect.exit(rpc.request({ type: "abort" })))._tag).toBe("Failure");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("bounds command waits", () =>
    Effect.gen(function* () {
      const rpc = yield* makePiRpcProcess({
        binaryPath: "node",
        cwd: process.cwd(),
        rpcArgs: [mockAgent],
        commandTimeoutMs: 20,
        environment: { ...process.env, PI_MOCK_DROP_GET_STATE: "1" },
      });
      const result = yield* Effect.exit(rpc.request({ type: "get_state" }));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(String(result.cause)).toContain("timed out");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
