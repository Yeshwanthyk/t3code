// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ApprovalRequestId,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { PiSettings } from "../pi/PiSettings.ts";
import {
  piCancelledExtensionUiResponse,
  piConfirmationResponse,
  piExtensionUiRuntimeRequestId,
  piUserInputResponse,
  projectPiExtensionUiDialog,
  type PiPendingExtensionUiRequest,
} from "../pi/PiExtensionUiRequests.ts";
import type { PiRpcAgentEvent, PiRpcEvent, PiRpcImage } from "../pi/PiRpcProtocol.ts";
import { decodePiResumeCursor } from "../pi/PiRpcProtocol.ts";
import {
  makePiSessionRuntime,
  parsePiModelSlug,
  type PiSessionRuntime,
} from "../pi/PiSessionRuntime.ts";
import {
  projectPiWorkflowArtifactChange,
  projectPiWorkflowChanges,
} from "../pi/PiWorkflowProjection.ts";
import { makeScopedPiWorkflowWatcher, type PiWorkflowScanResult } from "../pi/PiWorkflowWatcher.ts";
import { PI_PROVIDER_CAPABILITIES } from "./PiProvider.ts";
import * as Result from "effect/Result";

const PROVIDER = ProviderDriverKind.make("pi");

interface PiTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

interface PiSessionContext {
  session: ProviderSession;
  readonly runtime: PiSessionRuntime;
  readonly scope: Scope.Closeable;
  readonly turns: Array<PiTurnSnapshot>;
  activeTurnId: TurnId | undefined;
  abortRequested: boolean;
  observedTurnError: "aborted" | "error" | undefined;
  readonly startedItems: Set<string>;
  readonly textByItem: Map<string, string>;
  readonly pendingExtensionUi: Map<ApprovalRequestId, PiPendingExtensionUiState>;
  readonly settledExtensionUi: Set<string>;
  modelSupportsImages: boolean;
  closing: boolean;
  eventFiber: Fiber.Fiber<void, never> | undefined;
  exitFiber: Fiber.Fiber<void, never> | undefined;
}

interface PiPendingExtensionUiState {
  readonly pending: PiPendingExtensionUiRequest;
  readonly turnId: TurnId | undefined;
  timeoutFiber: Fiber.Fiber<void, never> | undefined;
}

export interface PiReplayContent {
  readonly kind: "assistant" | "reasoning";
  readonly text: string;
  readonly contentIndex: number;
}

export function extractPiReplayContent(entry: unknown): ReadonlyArray<PiReplayContent> {
  const entryRecord = record(entry);
  const message = record(entryRecord?.message);
  if (entryRecord?.type !== "message" || message?.role !== "assistant") return [];
  const content = Array.isArray(message.content) ? message.content : [];
  return content.flatMap((block, contentIndex): ReadonlyArray<PiReplayContent> => {
    const blockRecord = record(block);
    if (!blockRecord || typeof blockRecord.type !== "string") return [];
    if (blockRecord.type === "text" && typeof blockRecord.text === "string") {
      return [{ kind: "assistant", text: blockRecord.text, contentIndex }];
    }
    const thinking =
      typeof blockRecord.thinking === "string"
        ? blockRecord.thinking
        : typeof blockRecord.text === "string"
          ? blockRecord.text
          : undefined;
    return blockRecord.type === "thinking" && thinking
      ? [{ kind: "reasoning", text: thinking, contentIndex }]
      : [];
  });
}

export interface PiAdapterOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly rpcArgs?: ReadonlyArray<string>;
}

function toolItemType(name: string) {
  if (name === "bash") return "command_execution" as const;
  if (name === "edit" || name === "write") return "file_change" as const;
  return "dynamic_tool_call" as const;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function makePiAdapter(settings: PiSettings, options?: PiAdapterOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("pi");
    const serverConfig = yield* ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const workflowScans = yield* Queue.unbounded<PiWorkflowScanResult>();
    const sessions = new Map<ThreadId, PiSessionContext>();
    const piAgentDir =
      settings.agentDir?.trim() ||
      options?.environment?.PI_CODING_AGENT_DIR?.trim() ||
      process.env.PI_CODING_AGENT_DIR?.trim() ||
      NodePath.join(NodeOS.homedir(), ".pi", "agent");

    const uuid = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to create a Pi runtime identifier.",
            cause,
          }),
      ),
    );
    const eventBase = (context: PiSessionContext, raw?: unknown, itemId?: string) =>
      Effect.all({
        eventId: uuid.pipe(Effect.map(EventId.make)),
        createdAt: DateTime.now.pipe(Effect.map(DateTime.formatIso)),
      }).pipe(
        Effect.map(({ eventId, createdAt }) => ({
          eventId,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.session.threadId,
          createdAt,
          ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
          ...(itemId ? { itemId: RuntimeItemId.make(itemId) } : {}),
          ...(raw === undefined ? {} : { raw: { source: "pi.rpc" as const, payload: raw } }),
        })),
      );
    const emit = (event: ProviderRuntimeEvent) => Queue.offer(events, event).pipe(Effect.asVoid);

    const nativeSessionId = (context: PiSessionContext): string | undefined => {
      const decoded = decodePiResumeCursor(context.session.resumeCursor);
      return Result.isSuccess(decoded) ? decoded.success.sessionId : undefined;
    };

    const resolveWorkflowThreadId = (input: {
      readonly providerInstanceId: string;
      readonly nativeSessionId: string;
    }): ThreadId | undefined => {
      if (input.providerInstanceId !== boundInstanceId) return undefined;
      for (const context of sessions.values()) {
        if (nativeSessionId(context) === input.nativeSessionId) return context.session.threadId;
      }
      return undefined;
    };

    const workflowWatcher = yield* makeScopedPiWorkflowWatcher({
      providerInstanceId: boundInstanceId,
      piAgentDir,
    });
    workflowWatcher.start((scan) => {
      Queue.offerUnsafe(workflowScans, scan);
    });
    yield* Stream.runForEach(Stream.fromQueue(workflowScans), (scan) => {
      const projected = projectPiWorkflowChanges(scan.changes, resolveWorkflowThreadId);
      return Effect.forEach(projected.events, emit, { concurrency: 1, discard: true }).pipe(
        Effect.tap(() =>
          Effect.forEach(
            scan.issues,
            (issue) =>
              Effect.logWarning("Ignored invalid Pi workflow artifact update", {
                providerInstanceId: boundInstanceId,
                runId: issue.runId,
                issue: issue.code,
                detail: issue.message,
              }),
            { concurrency: 1, discard: true },
          ),
        ),
      );
    }).pipe(Effect.forkScoped);

    const extensionUiEventBase = Effect.fn("piExtensionUiEventBase")(function* (
      context: PiSessionContext,
      nativeRequestId: string,
      phase: "opened" | "resolved",
      raw: unknown,
      turnId: TurnId | undefined,
    ) {
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      return {
        eventId: EventId.make(
          `pi:${context.session.threadId}:extension-ui:${nativeRequestId}:${phase}`,
        ),
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.session.threadId,
        createdAt,
        ...(turnId ? { turnId } : {}),
        requestId: piExtensionUiRuntimeRequestId(nativeRequestId),
        raw: { source: "pi.rpc" as const, method: `extension_ui/${phase}`, payload: raw },
      };
    });

    const emitExtensionUiResolved = Effect.fn("emitPiExtensionUiResolved")(function* (
      context: PiSessionContext,
      state: PiPendingExtensionUiState,
      resolution:
        | { readonly kind: "approval"; readonly decision: ProviderApprovalDecision }
        | {
            readonly kind: "user-input";
            readonly answers: ProviderUserInputAnswers;
          }
        | { readonly kind: "cancelled"; readonly reason: string },
    ) {
      const { pending } = state;
      const base = yield* extensionUiEventBase(
        context,
        pending.nativeRequestId,
        "resolved",
        { method: pending.request.method, resolution },
        state.turnId,
      );
      if (pending.kind === "approval") {
        const decision = resolution.kind === "approval" ? resolution.decision : "cancel";
        yield* emit({
          ...base,
          type: "request.resolved",
          payload: {
            requestType: "unknown",
            decision,
            resolution,
          },
        });
        return;
      }
      const answers = resolution.kind === "user-input" ? resolution.answers : {};
      yield* emit({
        ...base,
        type: "user-input.resolved",
        payload: { answers },
      });
    });

    const settleExtensionUiState = Effect.fn("settlePiExtensionUiState")(function* (
      context: PiSessionContext,
      state: PiPendingExtensionUiState,
      resolution:
        | { readonly kind: "approval"; readonly decision: ProviderApprovalDecision }
        | { readonly kind: "user-input"; readonly answers: ProviderUserInputAnswers }
        | { readonly kind: "cancelled"; readonly reason: string },
      sendResponse: boolean,
    ) {
      if (context.pendingExtensionUi.get(state.pending.requestId) !== state) return false;
      context.pendingExtensionUi.delete(state.pending.requestId);
      context.settledExtensionUi.add(state.pending.nativeRequestId);
      if (state.timeoutFiber) yield* Fiber.interrupt(state.timeoutFiber);
      if (sendResponse) {
        const response =
          resolution.kind === "approval" && state.pending.kind === "approval"
            ? piConfirmationResponse(state.pending, resolution.decision)
            : resolution.kind === "user-input" && state.pending.kind === "user-input"
              ? piUserInputResponse(state.pending, resolution.answers)
              : piCancelledExtensionUiResponse(state.pending);
        if (response) {
          yield* context.runtime.process.respondToExtensionUi(response).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "extension_ui_response",
                  detail: cause.message,
                  cause,
                }),
            ),
          );
        }
      }
      yield* emitExtensionUiResolved(context, state, resolution);
      return true;
    });

    const cancelPendingExtensionUi = Effect.fn("cancelPendingPiExtensionUi")(function* (
      context: PiSessionContext,
      reason: string,
      sendResponse: boolean,
    ) {
      yield* Effect.forEach(
        [...context.pendingExtensionUi.values()],
        (state) =>
          settleExtensionUiState(context, state, { kind: "cancelled", reason }, sendResponse).pipe(
            Effect.catch(() => Effect.void),
          ),
        { concurrency: 1, discard: true },
      );
    });

    const closeContext = Effect.fn("closePiContext")(function* (context: PiSessionContext) {
      if (context.closing) return;
      context.closing = true;
      sessions.delete(context.session.threadId);
      yield* cancelPendingExtensionUi(context, "Pi session closed.", true);
      yield* Scope.close(context.scope, Exit.void).pipe(Effect.ignore);
    });

    const requireContext = Effect.fn("requirePiContext")(function* (threadId: ThreadId) {
      const context = sessions.get(threadId);
      if (!context) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      return context;
    });

    const updateCursor = Effect.fn("updatePiCursor")(function* (context: PiSessionContext) {
      const decoded = decodePiResumeCursor(context.session.resumeCursor);
      const previous = Result.isSuccess(decoded) ? decoded.success.lastEntryId : null;
      const reconciliation = yield* context.runtime.reconcile(previous).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: context.session.threadId,
              detail: cause.message,
              cause,
            }),
        ),
      );
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      context.session = { ...context.session, resumeCursor: reconciliation.cursor, updatedAt };
      return reconciliation;
    });

    const emitReplayEntries = Effect.fn("emitPiReplayEntries")(function* (
      context: PiSessionContext,
      entries: ReadonlyArray<{ readonly id: string; readonly [key: string]: unknown }>,
    ) {
      for (const entry of entries) {
        const content = extractPiReplayContent(entry);
        if (content.length === 0) continue;
        const turnId = TurnId.make(`pi-replay-${entry.id}`);
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const base = (suffix: string, itemId?: string) => ({
          eventId: EventId.make(`pi:${context.session.threadId}:${entry.id}:${suffix}`),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.session.threadId,
          turnId,
          createdAt,
          ...(itemId ? { itemId: RuntimeItemId.make(itemId) } : {}),
          raw: { source: "pi.rpc" as const, method: "get_entries", payload: entry },
        });
        yield* emit({ ...base("turn-started"), type: "turn.started", payload: {} });
        for (const block of content) {
          const itemId = `pi-entry-${entry.id}-${block.kind}-${block.contentIndex}`;
          const itemType = block.kind === "reasoning" ? "reasoning" : "assistant_message";
          const streamKind = block.kind === "reasoning" ? "reasoning_text" : "assistant_text";
          yield* emit({
            ...base(`item-started-${block.contentIndex}`, itemId),
            type: "item.started",
            payload: { itemType, status: "inProgress" },
          });
          yield* emit({
            ...base(`content-${block.contentIndex}`, itemId),
            type: "content.delta",
            payload: { streamKind, delta: block.text, contentIndex: block.contentIndex },
          });
          yield* emit({
            ...base(`item-completed-${block.contentIndex}`, itemId),
            type: "item.completed",
            payload: { itemType, status: "completed", detail: block.text },
          });
        }
        yield* emit({
          ...base("turn-completed"),
          type: "turn.completed",
          payload: { state: "completed" },
        });
      }
    });

    const handleAgentEvent = Effect.fn("handlePiAgentEvent")(function* (
      context: PiSessionContext,
      event: PiRpcAgentEvent,
    ) {
      switch (event.type) {
        case "agent_start": {
          if (!context.activeTurnId) break;
          yield* emit({
            ...(yield* eventBase(context, event)),
            type: "turn.started",
            payload: { model: context.session.model },
          });
          break;
        }
        case "message_update": {
          if (!context.activeTurnId) break;
          const update = record(event.assistantMessageEvent);
          if (!update || typeof update.type !== "string") break;
          if (update.type === "error") {
            const reason = update.reason;
            context.observedTurnError = reason === "aborted" ? "aborted" : "error";
            break;
          }
          if (update.type !== "text_delta" && update.type !== "thinking_delta") break;
          if (typeof update.delta !== "string" || update.delta.length === 0) break;
          const kind = update.type === "thinking_delta" ? "reasoning" : "assistant";
          const contentIndex = typeof update.contentIndex === "number" ? update.contentIndex : 0;
          const itemId = `${context.activeTurnId}-${kind}-${contentIndex}`;
          if (!context.startedItems.has(itemId)) {
            context.startedItems.add(itemId);
            yield* emit({
              ...(yield* eventBase(context, event, itemId)),
              type: "item.started",
              payload: {
                itemType: kind === "reasoning" ? "reasoning" : "assistant_message",
                status: "inProgress",
                title: kind === "reasoning" ? "Reasoning" : "Assistant message",
              },
            });
          }
          context.textByItem.set(itemId, (context.textByItem.get(itemId) ?? "") + update.delta);
          yield* emit({
            ...(yield* eventBase(context, event, itemId)),
            type: "content.delta",
            payload: {
              streamKind: kind === "reasoning" ? "reasoning_text" : "assistant_text",
              delta: update.delta,
              contentIndex,
            },
          });
          break;
        }
        case "message_end": {
          for (const itemId of context.textByItem.keys()) {
            const reasoning = itemId.includes("-reasoning-");
            const detail = context.textByItem.get(itemId);
            yield* emit({
              ...(yield* eventBase(context, event, itemId)),
              type: "item.completed",
              payload: {
                itemType: reasoning ? "reasoning" : "assistant_message",
                status: "completed",
                title: reasoning ? "Reasoning" : "Assistant message",
                ...(detail ? { detail } : {}),
              },
            });
          }
          break;
        }
        case "tool_execution_start": {
          if (!context.activeTurnId || typeof event.toolCallId !== "string") break;
          const name = typeof event.toolName === "string" ? event.toolName : "tool";
          context.startedItems.add(event.toolCallId);
          yield* emit({
            ...(yield* eventBase(context, event, event.toolCallId)),
            type: "item.started",
            payload: {
              itemType: toolItemType(name),
              status: "inProgress",
              title: name,
              data: { toolName: name, input: event.args },
            },
          });
          break;
        }
        case "tool_execution_update": {
          if (!context.activeTurnId || typeof event.toolCallId !== "string") break;
          const name = typeof event.toolName === "string" ? event.toolName : "tool";
          yield* emit({
            ...(yield* eventBase(context, event, event.toolCallId)),
            type: "item.updated",
            payload: {
              itemType: toolItemType(name),
              status: "inProgress",
              title: name,
              data: { toolName: name, input: event.args, partialResult: event.partialResult },
            },
          });
          break;
        }
        case "tool_execution_end": {
          if (!context.activeTurnId || typeof event.toolCallId !== "string") break;
          const name = typeof event.toolName === "string" ? event.toolName : "tool";
          yield* emit({
            ...(yield* eventBase(context, event, event.toolCallId)),
            type: "item.completed",
            payload: {
              itemType: toolItemType(name),
              status: event.isError === true ? "failed" : "completed",
              title: name,
              data: { toolName: name, input: event.args, result: event.result },
            },
          });
          break;
        }
        case "agent_settled": {
          if (!context.activeTurnId) break;
          const reconciliation = yield* Effect.exit(updateCursor(context));
          const wasAborted = context.abortRequested || context.observedTurnError === "aborted";
          const reconciliationFailed = Exit.isFailure(reconciliation);
          const wasError = context.observedTurnError === "error" || reconciliationFailed;
          if (reconciliationFailed) {
            yield* emit({
              ...(yield* eventBase(context, event)),
              type: "runtime.error",
              payload: {
                message: "Pi settled, but durable entry reconciliation failed.",
                class: "transport_error",
              },
            });
          }
          const updatedAt = DateTime.formatIso(yield* DateTime.now);
          context.session = {
            ...context.session,
            status: "ready",
            activeTurnId: undefined,
            updatedAt,
          };
          yield* emit(
            wasAborted
              ? {
                  ...(yield* eventBase(context, event)),
                  type: "turn.aborted",
                  payload: { reason: "Pi turn was aborted." },
                }
              : {
                  ...(yield* eventBase(context, event)),
                  type: "turn.completed",
                  payload: {
                    state: wasError ? "failed" : "completed",
                    ...(wasError
                      ? {
                          errorMessage: reconciliationFailed
                            ? "Pi durable replay reconciliation failed."
                            : "Pi reported an agent error.",
                        }
                      : {}),
                  },
                },
          );
          context.activeTurnId = undefined;
          context.abortRequested = false;
          context.observedTurnError = undefined;
          context.startedItems.clear();
          context.textByItem.clear();
          break;
        }
        case "agent_end":
        case "turn_start":
        case "turn_end":
        case "message_start":
        case "queue_update":
        case "compaction_start":
        case "compaction_end":
        case "auto_retry_start":
        case "auto_retry_end":
        case "extension_error":
          break;
      }
    });

    const handleEvent = Effect.fn("handlePiEvent")(function* (
      context: PiSessionContext,
      event: PiRpcEvent,
    ) {
      if (event.type === "extension_ui_request") {
        if (
          event.method === "notify" ||
          event.method === "setStatus" ||
          event.method === "setWidget" ||
          event.method === "setTitle" ||
          event.method === "set_editor_text"
        ) {
          // Pi documents these as fire-and-forget. Sending a dialog response is a
          // protocol violation, so fail closed by ignoring the presentation
          // mutation and making that decision visible to the canonical stream.
          yield* emit({
            ...(yield* eventBase(context, event)),
            type: "runtime.warning",
            payload: {
              message: `Pi extension UI operation '${event.method}' was ignored because T3 has no trusted presentation surface for it.`,
            },
          });
          return;
        }

        const projection = projectPiExtensionUiDialog(event);
        const existing = context.pendingExtensionUi.get(projection.pending.requestId);
        if (
          existing ||
          context.settledExtensionUi.has(projection.pending.nativeRequestId) ||
          context.closing
        ) {
          yield* emit({
            ...(yield* eventBase(context, event)),
            type: "runtime.warning",
            payload: {
              message: `Duplicate or closing Pi extension UI request '${event.id}' was ignored.`,
            },
          });
          return;
        }

        const state: PiPendingExtensionUiState = {
          pending: projection.pending,
          turnId: context.activeTurnId,
          timeoutFiber: undefined,
        };
        context.pendingExtensionUi.set(projection.pending.requestId, state);
        const base = yield* extensionUiEventBase(
          context,
          projection.pending.nativeRequestId,
          "opened",
          event,
          state.turnId,
        );
        yield* emit(
          projection.kind === "approval"
            ? { ...base, type: "request.opened", payload: projection.payload }
            : { ...base, type: "user-input.requested", payload: projection.payload },
        );

        const timeout = "timeout" in event ? event.timeout : undefined;
        if (typeof timeout === "number" && Number.isFinite(timeout) && timeout >= 0) {
          state.timeoutFiber = yield* Effect.sleep(`${timeout} millis`).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                state.timeoutFiber = undefined;
              }),
            ),
            Effect.andThen(
              settleExtensionUiState(
                context,
                state,
                { kind: "cancelled", reason: "Pi extension UI request timed out." },
                false,
              ),
            ),
            Effect.asVoid,
            Effect.catch(() => Effect.void),
            Effect.forkIn(context.scope),
          );
        }
        return;
      }
      yield* handleAgentEvent(context, event);
    });

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = Effect.fn(
      "PiAdapter.startSession",
    )(function* (input) {
      if (input.runtimeMode !== "full-access") {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "Pi currently supports only full-access runtime mode.",
        });
      }
      const existing = sessions.get(input.threadId);
      if (existing) yield* closeContext(existing);
      const sessionScope = yield* Scope.make();
      const runtimeExit = yield* Effect.exit(
        makePiSessionRuntime({
          binaryPath: settings.binaryPath,
          cwd: input.cwd ?? serverConfig.cwd,
          ...(options?.environment ? { environment: options.environment } : {}),
          ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
          ...(options?.rpcArgs ? { rpcArgs: options.rpcArgs } : {}),
        }).pipe(Effect.provideService(Scope.Scope, sessionScope)),
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      if (Exit.isFailure(runtimeExit)) {
        yield* Scope.close(sessionScope, Exit.void).pipe(Effect.ignore);
        return yield* new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: input.threadId,
          detail: String(runtimeExit.cause),
          cause: runtimeExit.cause,
        });
      }
      const runtime = runtimeExit.value;
      const state = yield* runtime.getState().pipe(
        Effect.tapError(() => Scope.close(sessionScope, Exit.void).pipe(Effect.ignore)),
        Effect.mapError(
          (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: cause.message,
              cause,
            }),
        ),
      );
      let effectiveModel = state.model;
      const resumed = decodePiResumeCursor(input.resumeCursor);
      const reconciliation = yield* runtime
        .reconcile(Result.isSuccess(resumed) ? resumed.success.lastEntryId : null)
        .pipe(
          Effect.tapError(() => Scope.close(sessionScope, Exit.void).pipe(Effect.ignore)),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: cause.message,
                cause,
              }),
          ),
        );
      if (input.modelSelection) {
        if (input.modelSelection.instanceId !== boundInstanceId) {
          yield* Scope.close(sessionScope, Exit.void).pipe(Effect.ignore);
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Pi model selection belongs to '${input.modelSelection.instanceId}', expected '${boundInstanceId}'.`,
          });
        }
        const selected = yield* runtime.setModel(input.modelSelection.model).pipe(
          Effect.tapError(() => Scope.close(sessionScope, Exit.void).pipe(Effect.ignore)),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "set_model",
                detail: cause.message,
                cause,
              }),
          ),
        );
        effectiveModel = selected;
        const effort = getModelSelectionStringOptionValue(input.modelSelection, "effort");
        if (effort) {
          if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effort)) {
            yield* Scope.close(sessionScope, Exit.void).pipe(Effect.ignore);
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Unsupported Pi thinking level '${effort}'.`,
            });
          }
          yield* runtime
            .setThinkingLevel(effort as Parameters<PiSessionRuntime["setThinkingLevel"]>[0])
            .pipe(
              Effect.tapError(() => Scope.close(sessionScope, Exit.void).pipe(Effect.ignore)),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "set_thinking_level",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
        }
      }
      const now = DateTime.formatIso(yield* DateTime.now);
      const session: ProviderSession = {
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        status: "ready",
        runtimeMode: "full-access",
        cwd: input.cwd ?? serverConfig.cwd,
        ...(input.modelSelection
          ? { model: input.modelSelection.model }
          : effectiveModel
            ? { model: `${effectiveModel.provider}/${effectiveModel.id}` }
            : {}),
        threadId: input.threadId,
        resumeCursor: reconciliation.cursor,
        createdAt: now,
        updatedAt: now,
      };
      const context: PiSessionContext = {
        session,
        runtime,
        scope: sessionScope,
        turns: [],
        activeTurnId: undefined,
        abortRequested: false,
        observedTurnError: undefined,
        startedItems: new Set(),
        textByItem: new Map(),
        pendingExtensionUi: new Map(),
        settledExtensionUi: new Set(),
        modelSupportsImages: effectiveModel?.input.includes("image") === true,
        closing: false,
        eventFiber: undefined,
        exitFiber: undefined,
      };
      sessions.set(input.threadId, context);
      const currentNativeSessionId = nativeSessionId(context);
      if (currentNativeSessionId) {
        yield* Effect.forEach(
          workflowWatcher
            .list()
            .filter((snapshot) => snapshot.sessionId === currentNativeSessionId)
            .flatMap((snapshot) =>
              projectPiWorkflowArtifactChange({
                current: snapshot,
                threadId: input.threadId,
              }),
            ),
          emit,
          { concurrency: 1, discard: true },
        );
      }
      context.eventFiber = yield* Stream.runForEach(runtime.events, (event) =>
        handleEvent(context, event).pipe(Effect.catch(() => Effect.void)),
      ).pipe(Effect.forkIn(sessionScope));
      context.exitFiber = yield* runtime.process.exit.pipe(
        Effect.flatMap(({ code, stderr }) =>
          Effect.gen(function* () {
            if (sessions.get(input.threadId) !== context) return;
            context.closing = true;
            sessions.delete(input.threadId);
            yield* cancelPendingExtensionUi(
              context,
              "Pi RPC process exited before the request was answered.",
              false,
            );
            const updatedAt = DateTime.formatIso(yield* DateTime.now);
            context.session = {
              ...context.session,
              status: "error",
              updatedAt,
              lastError: `Pi RPC process exited with code ${code}.`,
            };
            yield* emit({
              ...(yield* eventBase(context)),
              type: "session.exited",
              payload: {
                reason: stderr.text.trim() || `Pi RPC process exited with code ${code}.`,
                recoverable: true,
                exitKind: "error",
              },
            });
            // Closing a scope from one of its own child fibers can wait on that
            // fiber. Let a detached cleanup fiber close it after this handler exits.
            yield* Scope.close(context.scope, Exit.void).pipe(Effect.forkDetach);
          }),
        ),
        Effect.catch(() => Effect.void),
        Effect.forkIn(sessionScope),
      );
      yield* emitReplayEntries(context, reconciliation.entries);
      yield* emit({
        ...(yield* eventBase(context)),
        type: "session.started",
        payload: { message: "Pi session started", resume: reconciliation.cursor },
      });
      yield* emit({
        ...(yield* eventBase(context)),
        type: "thread.started",
        payload: { providerThreadId: state.sessionId },
      });
      return session;
    });

    const resolveImages = Effect.fn("resolvePiImages")(function* (input: ProviderSendTurnInput) {
      return yield* Effect.forEach(input.attachments ?? [], (attachment) =>
        Effect.gen(function* () {
          const path = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!path) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "prompt",
              detail: `Invalid attachment id '${attachment.id}'.`,
            });
          }
          const bytes = yield* fileSystem.readFile(path).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "prompt",
                  detail: "Failed to read Pi image attachment.",
                  cause,
                }),
            ),
          );
          return {
            type: "image",
            data: Buffer.from(bytes).toString("base64"),
            mimeType: attachment.mimeType,
          } satisfies PiRpcImage;
        }),
      );
    });

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = Effect.fn(
      "PiAdapter.sendTurn",
    )(function* (input) {
      const context = yield* requireContext(input.threadId);
      const text = input.input?.trim() ?? "";
      const images = yield* resolveImages(input);
      if (!text && images.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Pi turns require text or an image attachment.",
        });
      }
      if (input.modelSelection) {
        if (input.modelSelection.instanceId !== boundInstanceId) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Pi model selection belongs to '${input.modelSelection.instanceId}', expected '${boundInstanceId}'.`,
          });
        }
        if (!parsePiModelSlug(input.modelSelection.model)) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Pi models must use the 'provider/modelId' format.",
          });
        }
        const selected = yield* context.runtime.setModel(input.modelSelection.model).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "set_model",
                detail: cause.message,
                cause,
              }),
          ),
        );
        context.modelSupportsImages = selected.input.includes("image");
        const effort = getModelSelectionStringOptionValue(input.modelSelection, "effort");
        if (effort) {
          if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effort)) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: `Unsupported Pi thinking level '${effort}'.`,
            });
          }
          yield* context.runtime
            .setThinkingLevel(effort as Parameters<PiSessionRuntime["setThinkingLevel"]>[0])
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "set_thinking_level",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
        }
      }
      const steering = context.activeTurnId !== undefined;
      if (images.length > 0 && !context.modelSupportsImages) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "The selected Pi model doesn't support image input.",
        });
      }
      if (!steering) {
        yield* updateCursor(context);
      }
      const turnId = context.activeTurnId ?? TurnId.make(`pi-turn-${yield* uuid}`);
      if (!steering) {
        context.activeTurnId = turnId;
        context.turns.push({ id: turnId, items: [] });
      }
      const now = DateTime.formatIso(yield* DateTime.now);
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turnId,
        ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
        updatedAt: now,
      };
      yield* context.runtime
        .prompt({
          message: text || "Please inspect the attached image.",
          ...(images.length > 0 ? { images } : {}),
          ...(steering ? { streamingBehavior: "steer" } : {}),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "prompt",
                detail: cause.message,
                cause,
              }),
          ),
        );
      return { threadId: input.threadId, turnId, resumeCursor: context.session.resumeCursor };
    });

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = Effect.fn(
      "PiAdapter.interruptTurn",
    )(function* (threadId, turnId) {
      const context = yield* requireContext(threadId);
      if (turnId && context.activeTurnId && turnId !== context.activeTurnId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "interruptTurn",
          issue: `Turn '${turnId}' isn't the active Pi turn.`,
        });
      }
      context.abortRequested = true;
      yield* context.runtime.abort.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "abort",
              detail: cause.message,
              cause,
            }),
        ),
      );
    });

    const respondToRequest: ProviderAdapterShape<ProviderAdapterError>["respondToRequest"] =
      Effect.fn("PiAdapter.respondToRequest")(function* (threadId, requestId, decision) {
        const context = yield* requireContext(threadId);
        const state = context.pendingExtensionUi.get(requestId);
        if (!state || state.pending.kind !== "approval") {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "extension_ui_response",
            detail: `Unknown pending Pi confirmation request: ${requestId}`,
          });
        }
        yield* settleExtensionUiState(context, state, { kind: "approval", decision }, true);
      });

    const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] =
      Effect.fn("PiAdapter.respondToUserInput")(function* (threadId, requestId, answers) {
        const context = yield* requireContext(threadId);
        const state = context.pendingExtensionUi.get(requestId);
        if (!state || state.pending.kind !== "user-input") {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "extension_ui_response",
            detail: `Unknown pending Pi user-input request: ${requestId}`,
          });
        }
        if (!piUserInputResponse(state.pending, answers)) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "respondToUserInput",
            issue: `Pi request '${requestId}' requires one string answer for '${state.pending.questionId}'.`,
          });
        }
        yield* settleExtensionUiState(context, state, { kind: "user-input", answers }, true);
      });

    yield* Effect.addFinalizer(() =>
      Effect.forEach([...sessions.values()], closeContext, {
        concurrency: "unbounded",
        discard: true,
      }).pipe(
        Effect.ensuring(
          Effect.all([Queue.shutdown(events), Queue.shutdown(workflowScans)], {
            discard: true,
          }),
        ),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: { ...PI_PROVIDER_CAPABILITIES, sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession: (threadId) =>
        requireContext(threadId).pipe(Effect.flatMap(closeContext), Effect.asVoid),
      listSessions: () =>
        Effect.sync(() => [...sessions.values()].map((context) => context.session)),
      hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
      readThread: (threadId) =>
        requireContext(threadId).pipe(
          Effect.map((context) => ({ threadId, turns: context.turns })),
        ),
      rollbackThread: (_threadId, _numTurns) =>
        Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "Pi rollback isn't supported because native fork identity isn't persisted yet.",
          }),
        ),
      stopAll: () =>
        Effect.forEach([...sessions.values()], closeContext, {
          concurrency: "unbounded",
          discard: true,
        }),
      streamEvents: Stream.fromQueue(events),
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
}
