import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import type { PiRpcEvent, PiRpcImage, PiThinkingLevel } from "./PiRpcProtocol.ts";
import { decodePiResumeCursor, type PiResumeCursor } from "./PiRpcProtocol.ts";
import { makePiRpcProcess, type PiRpcProcess, PiRpcProcessError } from "./PiRpcProcess.ts";

export interface PiNativeModel {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly input: ReadonlyArray<string>;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
}

export interface PiNativeCommand {
  readonly name: string;
  readonly description?: string;
  readonly source?: string;
}

export interface PiSessionState {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly model: PiNativeModel | null;
  readonly thinkingLevel: PiThinkingLevel;
  readonly isStreaming: boolean;
}

export interface PiEntry {
  readonly id: string;
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface PiReconciliation {
  readonly entries: ReadonlyArray<PiEntry>;
  readonly cursor: PiResumeCursor;
}

export interface PiSessionRuntime {
  readonly process: PiRpcProcess;
  readonly events: Stream.Stream<PiRpcEvent>;
  readonly getState: () => Effect.Effect<PiSessionState, PiRpcProcessError>;
  readonly reconcile: (
    lastEntryId?: string | null,
  ) => Effect.Effect<PiReconciliation, PiRpcProcessError>;
  readonly prompt: (input: {
    readonly message: string;
    readonly images?: ReadonlyArray<PiRpcImage>;
    readonly streamingBehavior?: "steer" | "followUp";
  }) => Effect.Effect<void, PiRpcProcessError>;
  readonly abort: Effect.Effect<void, PiRpcProcessError>;
  readonly setModel: (slug: string) => Effect.Effect<PiNativeModel, PiRpcProcessError>;
  readonly setThinkingLevel: (level: PiThinkingLevel) => Effect.Effect<void, PiRpcProcessError>;
  readonly getAvailableModels: () => Effect.Effect<ReadonlyArray<PiNativeModel>, PiRpcProcessError>;
  readonly getCommands: () => Effect.Effect<ReadonlyArray<PiNativeCommand>, PiRpcProcessError>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  field: string,
  operation: string,
): Effect.Effect<string, PiRpcProcessError> {
  return typeof value === "string" && value.trim().length > 0
    ? Effect.succeed(value.trim())
    : Effect.fail(
        new PiRpcProcessError({
          operation,
          detail: `Pi response is missing '${field}'.`,
        }),
      );
}

export const parsePiModel = (
  value: unknown,
  operation = "parse model",
): Effect.Effect<PiNativeModel, PiRpcProcessError> =>
  Effect.gen(function* () {
    if (!isRecord(value)) {
      return yield* new PiRpcProcessError({ operation, detail: "Pi returned an invalid model." });
    }
    const provider = yield* requiredString(value.provider, "provider", operation);
    const id = yield* requiredString(value.id, "id", operation);
    const name =
      typeof value.name === "string" && value.name.trim().length > 0 ? value.name.trim() : id;
    return {
      provider,
      id,
      name,
      reasoning: value.reasoning === true,
      input: Array.isArray(value.input)
        ? value.input.filter((item): item is string => typeof item === "string")
        : [],
      ...(typeof value.contextWindow === "number" ? { contextWindow: value.contextWindow } : {}),
      ...(typeof value.maxTokens === "number" ? { maxTokens: value.maxTokens } : {}),
    };
  });

export const parsePiSessionState = (
  data: unknown,
): Effect.Effect<PiSessionState, PiRpcProcessError> =>
  Effect.gen(function* () {
    if (!isRecord(data)) {
      return yield* new PiRpcProcessError({
        operation: "get_state",
        detail: "Pi returned an invalid state payload.",
      });
    }
    const sessionId = yield* requiredString(data.sessionId, "sessionId", "get_state");
    const sessionFile = yield* requiredString(data.sessionFile, "sessionFile", "get_state");
    const thinkingLevel = typeof data.thinkingLevel === "string" ? data.thinkingLevel : "off";
    if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinkingLevel)) {
      return yield* new PiRpcProcessError({
        operation: "get_state",
        detail: `Pi returned unsupported thinking level '${thinkingLevel}'.`,
      });
    }
    return {
      sessionId,
      sessionFile,
      model:
        data.model === null || data.model === undefined ? null : yield* parsePiModel(data.model),
      thinkingLevel: thinkingLevel as PiThinkingLevel,
      isStreaming: data.isStreaming === true,
    };
  });

export function parsePiModelSlug(slug: string): { provider: string; modelId: string } | null {
  const separator = slug.indexOf("/");
  if (separator <= 0 || separator === slug.length - 1) return null;
  const provider = slug.slice(0, separator).trim();
  const modelId = slug.slice(separator + 1).trim();
  return provider && modelId ? { provider, modelId } : null;
}

export const makePiSessionRuntime = Effect.fn("makePiSessionRuntime")(function* (options: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly resumeCursor?: unknown;
  readonly rpcArgs?: ReadonlyArray<string>;
}): Effect.fn.Return<
  PiSessionRuntime,
  PiRpcProcessError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  const process = yield* makePiRpcProcess({
    binaryPath: options.binaryPath,
    cwd: options.cwd,
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.rpcArgs ? { rpcArgs: options.rpcArgs } : {}),
  });
  const decodedCursor = decodePiResumeCursor(options.resumeCursor);
  const resumeCursor = Result.isSuccess(decodedCursor) ? decodedCursor.success : undefined;

  if (resumeCursor) {
    const switched = yield* process.request({
      type: "switch_session",
      sessionPath: resumeCursor.sessionFile,
    });
    if (isRecord(switched.data) && switched.data.cancelled === true) {
      return yield* new PiRpcProcessError({
        operation: "switch_session",
        detail: "A Pi extension cancelled session restoration.",
      });
    }
  }

  const getState = Effect.fn("PiSessionRuntime.getState")(function* () {
    const response = yield* process.request({ type: "get_state" });
    return yield* parsePiSessionState(response.data);
  });

  const initialState = yield* getState();
  if (
    resumeCursor &&
    (initialState.sessionId !== resumeCursor.sessionId ||
      initialState.sessionFile !== resumeCursor.sessionFile)
  ) {
    return yield* new PiRpcProcessError({
      operation: "resume",
      detail: "Pi restored a different native session than the durable T3 cursor.",
    });
  }

  const reconcile = Effect.fn("PiSessionRuntime.reconcile")(function* (
    lastEntryId?: string | null,
  ) {
    const response = yield* process.request({
      type: "get_entries",
      ...(lastEntryId ? { since: lastEntryId } : {}),
    });
    if (!isRecord(response.data) || !Array.isArray(response.data.entries)) {
      return yield* new PiRpcProcessError({
        operation: "get_entries",
        detail: "Pi returned an invalid entry replay payload.",
      });
    }
    const entries = response.data.entries.filter(
      (entry): entry is PiEntry =>
        isRecord(entry) && typeof entry.id === "string" && typeof entry.type === "string",
    );
    if (entries.length !== response.data.entries.length) {
      return yield* new PiRpcProcessError({
        operation: "get_entries",
        detail: "Pi returned an entry without a stable identity.",
      });
    }
    const leafId = typeof response.data.leafId === "string" ? response.data.leafId : null;
    return {
      entries,
      cursor: {
        version: 1,
        sessionId: initialState.sessionId,
        sessionFile: initialState.sessionFile,
        lastEntryId: leafId,
      },
    } satisfies PiReconciliation;
  });

  const prompt: PiSessionRuntime["prompt"] = Effect.fn("PiSessionRuntime.prompt")(
    function* (input) {
      yield* process.request({ type: "prompt", ...input });
    },
  );

  const setModel: PiSessionRuntime["setModel"] = Effect.fn("PiSessionRuntime.setModel")(
    function* (slug) {
      const parsed = parsePiModelSlug(slug);
      if (!parsed) {
        return yield* new PiRpcProcessError({
          operation: "set_model",
          detail: "Pi models must use the 'provider/modelId' format.",
        });
      }
      const response = yield* process.request({
        type: "set_model",
        provider: parsed.provider,
        modelId: parsed.modelId,
      });
      return yield* parsePiModel(response.data, "set_model");
    },
  );

  const getAvailableModels = Effect.fn("PiSessionRuntime.getAvailableModels")(function* () {
    const response = yield* process.request({ type: "get_available_models" });
    if (!isRecord(response.data) || !Array.isArray(response.data.models)) {
      return yield* new PiRpcProcessError({
        operation: "get_available_models",
        detail: "Pi returned an invalid model catalog.",
      });
    }
    return yield* Effect.forEach(response.data.models, (model) =>
      parsePiModel(model, "get_available_models"),
    );
  });

  const getCommands = Effect.fn("PiSessionRuntime.getCommands")(function* () {
    const response = yield* process.request({ type: "get_commands" });
    if (!isRecord(response.data) || !Array.isArray(response.data.commands)) {
      return yield* new PiRpcProcessError({
        operation: "get_commands",
        detail: "Pi returned an invalid slash-command catalog.",
      });
    }
    return response.data.commands.flatMap((command): ReadonlyArray<PiNativeCommand> => {
      if (!isRecord(command) || typeof command.name !== "string" || command.name.length === 0) {
        return [];
      }
      return [
        {
          name: command.name,
          ...(typeof command.description === "string" ? { description: command.description } : {}),
          ...(typeof command.source === "string" ? { source: command.source } : {}),
        },
      ];
    });
  });

  return {
    process,
    events: process.events,
    getState,
    reconcile,
    prompt,
    abort: process.request({ type: "abort" }).pipe(Effect.asVoid),
    setModel,
    setThinkingLevel: (level) =>
      process.request({ type: "set_thinking_level", level }).pipe(
        Effect.andThen(getState()),
        Effect.flatMap((state) =>
          state.thinkingLevel === level
            ? Effect.void
            : Effect.fail(
                new PiRpcProcessError({
                  operation: "set_thinking_level",
                  detail: `Pi applied '${state.thinkingLevel}' instead of requested '${level}'.`,
                }),
              ),
        ),
      ),
    getAvailableModels,
    getCommands,
  };
});
