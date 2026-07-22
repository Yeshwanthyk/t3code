// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import {
  ApprovalRequestId,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { extractPiReplayContent, makePiAdapter } from "./PiAdapter.ts";

const dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgent = NodePath.join(dirname, "../../../scripts/pi-rpc-mock-agent.ts");
const extensionUiMockAgent = NodePath.join(
  dirname,
  "../pi/__fixtures__/extension-ui-mock-agent.mjs",
);
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

  effectIt.effect("round-trips one Pi confirmation and rejects a second terminal response", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("pi-test");
      const threadId = ThreadId.make("pi-confirmation");
      const adapter = yield* makePiAdapter(
        { enabled: true, binaryPath: "node" },
        {
          instanceId,
          rpcArgs: [extensionUiMockAgent],
          environment: { ...process.env, PI_MOCK_UI_METHOD: "confirm" },
        },
      );
      const requested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
      const resolved =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.resolved" }>>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (event.type === "request.opened")
          return Deferred.succeed(requested, event).pipe(Effect.ignore);
        if (event.type === "request.resolved")
          return Deferred.succeed(resolved, event).pipe(Effect.ignore);
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        providerInstanceId: instanceId,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "ask" });
      const opened = yield* Deferred.await(requested);
      expect(String(opened.requestId)).toBe("pi-confirm-1");
      expect(opened.payload.requestType).toBe("unknown");

      const requestId = ApprovalRequestId.make(String(opened.requestId));
      yield* adapter.respondToRequest(threadId, requestId, "accept");
      const closed = yield* Deferred.await(resolved);
      expect(closed.payload.decision).toBe("accept");

      const duplicate = yield* Effect.exit(
        adapter.respondToRequest(threadId, requestId, "decline"),
      );
      expect(duplicate._tag).toBe("Failure");
      if (duplicate._tag === "Failure") {
        expect(String(duplicate.cause)).toContain("Unknown pending Pi confirmation request");
      }
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  effectIt.effect("cancels pending Pi user input when the session closes", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("pi-test");
      const threadId = ThreadId.make("pi-input-close");
      const adapter = yield* makePiAdapter(
        { enabled: true, binaryPath: "node" },
        { instanceId, rpcArgs: [extensionUiMockAgent], environment: { ...process.env } },
      );
      const requested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
      const resolved =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.resolved" }>>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (event.type === "user-input.requested") {
          return Deferred.succeed(requested, event).pipe(Effect.ignore);
        }
        if (event.type === "user-input.resolved") {
          return Deferred.succeed(resolved, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        providerInstanceId: instanceId,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "ask" });
      const opened = yield* Deferred.await(requested);
      expect(String(opened.requestId)).toBe("pi-input-1");
      yield* adapter.stopSession(threadId);
      expect((yield* Deferred.await(resolved)).payload.answers).toEqual({});
      expect(yield* adapter.hasSession(threadId)).toBe(false);
      yield* Fiber.interrupt(eventsFiber);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  effectIt.effect("round-trips Pi input through the canonical user-input lifecycle", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("pi-test");
      const threadId = ThreadId.make("pi-input-response");
      const adapter = yield* makePiAdapter(
        { enabled: true, binaryPath: "node" },
        { instanceId, rpcArgs: [extensionUiMockAgent], environment: { ...process.env } },
      );
      const requested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
      const resolved =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.resolved" }>>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (event.type === "user-input.requested") {
          return Deferred.succeed(requested, event).pipe(Effect.ignore);
        }
        if (event.type === "user-input.resolved") {
          return Deferred.succeed(resolved, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        providerInstanceId: instanceId,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "ask" });
      const opened = yield* Deferred.await(requested);
      const questionId = opened.payload.questions[0]!.id;
      yield* adapter.respondToUserInput(
        threadId,
        ApprovalRequestId.make(String(opened.requestId)),
        { [questionId]: "answer" },
      );
      expect((yield* Deferred.await(resolved)).payload.answers).toEqual({
        [questionId]: "answer",
      });
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  effectIt.effect("removes an unexpectedly exited binding so routing can recover it", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("pi-test");
      const threadId = ThreadId.make("pi-crash-recovery");
      const adapter = yield* makePiAdapter(
        { enabled: true, binaryPath: "node" },
        {
          instanceId,
          rpcArgs: [mockAgent],
          environment: {
            ...process.env,
            PI_MOCK_EXIT_ON_ABORT: "1",
            PI_MOCK_FRESH_EMPTY: "1",
          },
        },
      );
      const exited =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "session.exited" }>>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "session.exited"
          ? Deferred.succeed(exited, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        providerInstanceId: instanceId,
        runtimeMode: "full-access",
      });
      // The process intentionally exits before acknowledging abort, so the
      // initiating call may fail while the recoverable exit event still wins.
      yield* Effect.exit(adapter.interruptTurn(threadId));
      const exitEvent = yield* Deferred.await(exited);
      expect(exitEvent.payload.recoverable).toBe(true);
      expect(yield* adapter.hasSession(threadId)).toBe(false);
      yield* Fiber.interrupt(eventsFiber);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  effectIt.effect("reconstructs a matching native-session workflow through canonical tasks", () =>
    Effect.gen(function* () {
      const agentDir = yield* Effect.acquireRelease(
        Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-workflow-"))),
        (directory) =>
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      );
      const runId = "wf_0123456789ab";
      const runDir = NodePath.join(agentDir, "workflows", runId);
      NodeFS.mkdirSync(runDir, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(runDir, "transcripts.json"), "{}");
      NodeFS.writeFileSync(
        NodePath.join(runDir, "workflow.json"),
        `{"runId":"${runId}","sessionId":"fresh-session","name":"Verify the Pi adapter","background":true,"status":"completed","startedAt":10,"finishedAt":20,"phases":[{"title":"Verify"}],"currentPhase":"Verify","agents":[{"index":0,"label":"verifier","state":"done","queuedAt":10,"startedAt":11,"finishedAt":20,"preview":"verified","usage":{},"transcript":[]}],"transcriptArtifact":"transcripts.json"}`,
      );

      const instanceId = ProviderInstanceId.make("pi-workflow-test");
      const threadId = ThreadId.make("pi-workflow-thread");
      const adapter = yield* makePiAdapter(
        { enabled: true, binaryPath: "node", agentDir },
        {
          instanceId,
          rpcArgs: [mockAgent],
          environment: { ...process.env, PI_MOCK_FRESH_EMPTY: "1" },
        },
      );
      const completed =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "task.completed" }>>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "task.completed"
          ? Deferred.succeed(completed, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        providerInstanceId: instanceId,
        runtimeMode: "full-access",
      });
      const event = yield* Deferred.await(completed);
      expect(event.threadId).toBe(threadId);
      expect(event.payload).toMatchObject({ status: "completed" });
      expect(String(event.payload.taskId)).toContain(runId);
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
