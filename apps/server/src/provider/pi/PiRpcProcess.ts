import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  decodePiRpcOutputRecord,
  PiRpcBoundedStderr,
  type PiRpcCommand,
  type PiRpcEvent,
  type PiRpcExtensionUIResponse,
  type PiRpcResponse,
  PiRpcRecordDecoder,
  routePiRpcOutputRecord,
  serializePiRpcInputRecord,
} from "./PiRpcProtocol.ts";

export class PiRpcProcessError extends Schema.TaggedErrorClass<PiRpcProcessError>()(
  "PiRpcProcessError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Pi RPC ${this.operation} failed: ${this.detail}`;
  }
}

export interface PiRpcProcessOptions {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly args?: ReadonlyArray<string>;
  /** Test/alternate launcher seam. Pi production calls use the default RPC arguments. */
  readonly rpcArgs?: ReadonlyArray<string>;
  readonly maxRecordBytes?: number;
  readonly maxStderrBytes?: number;
  readonly commandTimeoutMs?: number;
}

export interface PiRpcProcess {
  readonly request: (command: PiRpcCommand) => Effect.Effect<PiRpcResponse, PiRpcProcessError>;
  readonly events: Stream.Stream<PiRpcEvent>;
  readonly respondToExtensionUi: (
    response: PiRpcExtensionUIResponse,
  ) => Effect.Effect<void, PiRpcProcessError>;
  readonly exit: Effect.Effect<
    {
      readonly code: number;
      readonly stderr: ReturnType<PiRpcBoundedStderr["snapshot"]>;
    },
    PiRpcProcessError
  >;
  readonly stderr: Effect.Effect<ReturnType<PiRpcBoundedStderr["snapshot"]>>;
  readonly close: Effect.Effect<void>;
}

export const makePiRpcProcess = Effect.fn("makePiRpcProcess")(function* (
  options: PiRpcProcessOptions,
): Effect.fn.Return<
  PiRpcProcess,
  PiRpcProcessError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const resolved = yield* resolveSpawnCommand(
    options.binaryPath,
    [...(options.rpcArgs ?? ["--mode", "rpc", "--approve"]), ...(options.args ?? [])],
    options.environment === undefined ? {} : { env: options.environment, extendEnv: true },
  ).pipe(
    Effect.mapError(
      (cause) =>
        new PiRpcProcessError({
          operation: "resolve executable",
          detail: `Could not resolve '${options.binaryPath}'.`,
          cause,
        }),
    ),
  );
  const child = yield* spawner
    .spawn(
      ChildProcess.make(resolved.command, resolved.args, {
        cwd: options.cwd,
        ...(options.environment ? { env: options.environment, extendEnv: true } : {}),
        shell: resolved.shell,
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new PiRpcProcessError({
            operation: "spawn",
            detail: `Could not start '${options.binaryPath} --mode rpc'.`,
            cause,
          }),
      ),
    );

  const pending = new Map<string, Deferred.Deferred<PiRpcResponse, PiRpcProcessError>>();
  const events = yield* Queue.unbounded<PiRpcEvent>();
  const inputQueue = yield* Queue.unbounded<Uint8Array>();
  const stderr = new PiRpcBoundedStderr(
    options.maxStderrBytes === undefined ? undefined : { maxBytes: options.maxStderrBytes },
  );
  const decoder = new PiRpcRecordDecoder(
    options.maxRecordBytes === undefined ? undefined : { maxRecordBytes: options.maxRecordBytes },
  );
  let requestSequence = 0;
  let closed = false;

  const failPending = (error: PiRpcProcessError) =>
    Effect.forEach([...pending.values()], (deferred) => Deferred.fail(deferred, error), {
      discard: true,
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          pending.clear();
        }),
      ),
    );

  yield* Stream.run(Stream.fromQueue(inputQueue), child.stdin).pipe(
    Effect.catchCause((cause) =>
      failPending(
        new PiRpcProcessError({
          operation: "stdin",
          detail: "Pi RPC stdin closed before the command completed.",
          cause,
        }),
      ),
    ),
    Effect.forkChild,
  );

  const handleFrames = (frames: ReturnType<PiRpcRecordDecoder["push"]>) =>
    Effect.forEach(
      frames,
      (frame) => {
        if (!frame.ok) {
          return Effect.logWarning("discarding malformed Pi RPC stdout record", {
            code: frame.error.code,
            byteLength: frame.error.byteLength,
          });
        }
        const decoded = decodePiRpcOutputRecord(frame.value);
        if (!decoded.ok) {
          return Effect.logWarning("discarding unsupported Pi RPC stdout record", {
            code: decoded.error.code,
            recordType: decoded.error.recordType,
          });
        }
        const route = routePiRpcOutputRecord(decoded.record);
        if (route.kind === "event") {
          return Queue.offer(events, route.event).pipe(Effect.asVoid);
        }
        if (route.kind === "uncorrelated_response") {
          return Effect.logWarning("discarding uncorrelated Pi RPC response", {
            command: route.response.command,
          });
        }
        const deferred = pending.get(route.requestId);
        if (!deferred) {
          return Effect.logWarning("discarding unknown Pi RPC response id", {
            command: route.response.command,
            requestId: route.requestId,
          });
        }
        pending.delete(route.requestId);
        return Deferred.succeed(deferred, route.response).pipe(Effect.asVoid);
      },
      { discard: true },
    );

  yield* Stream.runForEach(child.stdout, (chunk) => handleFrames(decoder.push(chunk))).pipe(
    Effect.ensuring(handleFrames(decoder.finish())),
    Effect.catchCause((cause) =>
      failPending(
        new PiRpcProcessError({
          operation: "stdout",
          detail: "Pi RPC stdout closed before the command completed.",
          cause,
        }),
      ),
    ),
    Effect.forkChild,
  );
  yield* Stream.runForEach(child.stderr, (chunk) => Effect.sync(() => stderr.append(chunk))).pipe(
    Effect.catchCause(() => Effect.void),
    Effect.forkChild,
  );

  const exit = child.exitCode.pipe(
    Effect.map((code) => ({ code: Number(code), stderr: stderr.snapshot() })),
    Effect.mapError(
      (cause) =>
        new PiRpcProcessError({
          operation: "exit",
          detail: "Could not observe Pi RPC process exit.",
          cause,
        }),
    ),
  );
  yield* exit.pipe(
    Effect.flatMap(({ code }) =>
      Effect.sync(() => {
        closed = true;
      }).pipe(
        Effect.andThen(Queue.shutdown(inputQueue)),
        Effect.andThen(
          failPending(
            new PiRpcProcessError({
              operation: "request",
              detail: `Pi RPC process exited with code ${code}.`,
            }),
          ),
        ),
      ),
    ),
    Effect.ensuring(Queue.shutdown(events)),
    Effect.catch(() => Effect.void),
    Effect.forkChild,
  );

  const request: PiRpcProcess["request"] = Effect.fn("PiRpcProcess.request")(function* (command) {
    if (closed) {
      return yield* new PiRpcProcessError({
        operation: command.type,
        detail: "Pi RPC process is closed.",
      });
    }
    requestSequence += 1;
    const id = `t3-pi-${requestSequence}`;
    const response = yield* Deferred.make<PiRpcResponse, PiRpcProcessError>();
    pending.set(id, response);
    const wire = yield* Effect.try({
      try: () => serializePiRpcInputRecord({ ...command, id }),
      catch: (cause) =>
        new PiRpcProcessError({
          operation: command.type,
          detail: "Command could not be serialized.",
          cause,
        }),
    });
    yield* Queue.offer(inputQueue, new TextEncoder().encode(wire)).pipe(
      Effect.mapError(
        (cause) =>
          new PiRpcProcessError({
            operation: command.type,
            detail: "Command could not be queued for stdin.",
            cause,
          }),
      ),
      Effect.onError(() =>
        Effect.sync(() => {
          pending.delete(id);
        }),
      ),
    );
    const resultOption = yield* Deferred.await(response).pipe(
      Effect.timeoutOption(options.commandTimeoutMs ?? 30_000),
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          pending.delete(id);
        }),
      ),
    );
    if (Option.isNone(resultOption)) {
      pending.delete(id);
      return yield* new PiRpcProcessError({
        operation: command.type,
        detail: `Command timed out after ${options.commandTimeoutMs ?? 30_000}ms.`,
      });
    }
    const result = resultOption.value;
    if (!result.success) {
      return yield* new PiRpcProcessError({
        operation: command.type,
        detail: result.error ?? "Pi rejected the command.",
      });
    }
    return result;
  });

  const respondToExtensionUi: PiRpcProcess["respondToExtensionUi"] = Effect.fn(
    "PiRpcProcess.respondToExtensionUi",
  )(function* (response) {
    const wire = yield* Effect.try({
      try: () => serializePiRpcInputRecord(response),
      catch: (cause) =>
        new PiRpcProcessError({
          operation: "extension_ui_response",
          detail: "Response could not be serialized.",
          cause,
        }),
    });
    yield* Queue.offer(inputQueue, new TextEncoder().encode(wire)).pipe(
      Effect.mapError(
        (cause) =>
          new PiRpcProcessError({
            operation: "extension_ui_response",
            detail: "Response could not be queued for stdin.",
            cause,
          }),
      ),
    );
  });

  const close = Effect.gen(function* () {
    if (closed) return;
    closed = true;
    yield* Queue.shutdown(inputQueue);
    yield* failPending(
      new PiRpcProcessError({ operation: "close", detail: "Pi RPC process was closed." }),
    );
    yield* child.kill().pipe(Effect.ignore);
  });

  yield* Effect.addFinalizer(() =>
    close.pipe(
      Effect.ensuring(Queue.shutdown(events)),
      Effect.ensuring(Queue.shutdown(inputQueue)),
    ),
  );

  return {
    request,
    events: Stream.fromQueue(events),
    respondToExtensionUi,
    exit,
    stderr: Effect.sync(() => stderr.snapshot()),
    close,
  };
});
