import * as Schema from "effect/Schema";

export const DEFAULT_PI_RPC_MAX_RECORD_BYTES = 4 * 1024 * 1024;
export const DEFAULT_PI_RPC_MAX_STDERR_BYTES = 64 * 1024;

export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PiRpcImage {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

type PiRpcMessageCommand = {
  readonly id?: string;
  readonly message: string;
  readonly images?: ReadonlyArray<PiRpcImage>;
};

export type PiRpcCommand =
  | (PiRpcMessageCommand & {
      readonly type: "prompt";
      readonly streamingBehavior?: "steer" | "followUp";
    })
  | (PiRpcMessageCommand & { readonly type: "steer" })
  | (PiRpcMessageCommand & { readonly type: "follow_up" })
  | { readonly id?: string; readonly type: "abort" }
  | { readonly id?: string; readonly type: "new_session"; readonly parentSession?: string }
  | { readonly id?: string; readonly type: "get_state" }
  | {
      readonly id?: string;
      readonly type: "set_model";
      readonly provider: string;
      readonly modelId: string;
    }
  | { readonly id?: string; readonly type: "cycle_model" }
  | { readonly id?: string; readonly type: "get_available_models" }
  | { readonly id?: string; readonly type: "set_thinking_level"; readonly level: PiThinkingLevel }
  | { readonly id?: string; readonly type: "cycle_thinking_level" }
  | {
      readonly id?: string;
      readonly type: "set_steering_mode" | "set_follow_up_mode";
      readonly mode: "all" | "one-at-a-time";
    }
  | { readonly id?: string; readonly type: "compact"; readonly customInstructions?: string }
  | {
      readonly id?: string;
      readonly type: "set_auto_compaction" | "set_auto_retry";
      readonly enabled: boolean;
    }
  | { readonly id?: string; readonly type: "abort_retry" | "abort_bash" }
  | {
      readonly id?: string;
      readonly type: "bash";
      readonly command: string;
      readonly excludeFromContext?: boolean;
    }
  | { readonly id?: string; readonly type: "get_session_stats" }
  | { readonly id?: string; readonly type: "export_html"; readonly outputPath?: string }
  | { readonly id?: string; readonly type: "switch_session"; readonly sessionPath: string }
  | { readonly id?: string; readonly type: "fork"; readonly entryId: string }
  | { readonly id?: string; readonly type: "clone" }
  | { readonly id?: string; readonly type: "get_fork_messages" }
  | { readonly id?: string; readonly type: "get_entries"; readonly since?: string }
  | { readonly id?: string; readonly type: "get_tree" }
  | { readonly id?: string; readonly type: "get_last_assistant_text" }
  | { readonly id?: string; readonly type: "set_session_name"; readonly name: string }
  | { readonly id?: string; readonly type: "get_messages" }
  | { readonly id?: string; readonly type: "get_commands" };

export type PiRpcExtensionUIResponse =
  | { readonly type: "extension_ui_response"; readonly id: string; readonly value: string }
  | { readonly type: "extension_ui_response"; readonly id: string; readonly confirmed: boolean }
  | { readonly type: "extension_ui_response"; readonly id: string; readonly cancelled: true };

export type PiRpcInputRecord = PiRpcCommand | PiRpcExtensionUIResponse;

export interface PiRpcResponse {
  readonly type: "response";
  readonly id?: string;
  readonly command: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

export const PI_RPC_AGENT_EVENT_TYPES = [
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "queue_update",
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "extension_error",
] as const;

export type PiRpcAgentEventType = (typeof PI_RPC_AGENT_EVENT_TYPES)[number];

export interface PiRpcAgentEvent {
  readonly type: PiRpcAgentEventType;
  readonly [key: string]: unknown;
}

export interface PiRpcExtensionUIRequest {
  readonly type: "extension_ui_request";
  readonly id: string;
  readonly method:
    | "select"
    | "confirm"
    | "input"
    | "editor"
    | "notify"
    | "setStatus"
    | "setWidget"
    | "setTitle"
    | "set_editor_text";
  readonly [key: string]: unknown;
}

export type PiRpcEvent = PiRpcAgentEvent | PiRpcExtensionUIRequest;
export type PiRpcOutputRecord = PiRpcResponse | PiRpcEvent;

export type PiRpcOutputRoute =
  | { readonly kind: "response"; readonly requestId: string; readonly response: PiRpcResponse }
  | { readonly kind: "uncorrelated_response"; readonly response: PiRpcResponse }
  | { readonly kind: "event"; readonly event: PiRpcEvent };

export type PiRpcFrameErrorCode =
  | "empty_record"
  | "invalid_utf8"
  | "invalid_json"
  | "record_too_large";

export interface PiRpcFrameError {
  readonly code: PiRpcFrameErrorCode;
  readonly message: string;
  readonly byteLength: number;
}

export type PiRpcFrame =
  | { readonly ok: true; readonly value: unknown; readonly byteLength: number }
  | { readonly ok: false; readonly error: PiRpcFrameError };

export type PiRpcOutputDecodeErrorCode =
  | "invalid_envelope"
  | "invalid_response"
  | "invalid_event"
  | "unsupported_record_type";

export interface PiRpcOutputDecodeError {
  readonly code: PiRpcOutputDecodeErrorCode;
  readonly message: string;
  readonly recordType?: string;
}

export type PiRpcOutputDecodeResult =
  | { readonly ok: true; readonly record: PiRpcOutputRecord }
  | { readonly ok: false; readonly error: PiRpcOutputDecodeError };

export const PiResumeCursorSchema = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.NonEmptyString,
  sessionFile: Schema.NonEmptyString,
  lastEntryId: Schema.NullOr(Schema.NonEmptyString),
});

export type PiResumeCursor = typeof PiResumeCursorSchema.Type;
export const decodePiResumeCursor = Schema.decodeUnknownResult(PiResumeCursorSchema);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasRecord(value: Record<string, unknown>, key: string): boolean {
  return isRecord(value[key]);
}

function hasArray(value: Record<string, unknown>, key: string): boolean {
  return Array.isArray(value[key]);
}

function validateAgentEvent(
  record: Record<string, unknown>,
  type: PiRpcAgentEventType,
): string | null {
  switch (type) {
    case "agent_start":
    case "agent_settled":
    case "turn_start":
      return null;
    case "agent_end":
      return hasArray(record, "messages") && typeof record.willRetry === "boolean"
        ? null
        : "agent_end requires messages and willRetry";
    case "turn_end":
      return hasRecord(record, "message") && hasArray(record, "toolResults")
        ? null
        : "turn_end requires message and toolResults";
    case "message_start":
    case "message_end":
      return hasRecord(record, "message") ? null : `${type} requires message`;
    case "message_update": {
      const update = record.assistantMessageEvent;
      if (!hasRecord(record, "message") || !isRecord(update)) {
        return "message_update requires message and assistantMessageEvent";
      }
      const updateType = update.type;
      const supportedUpdates = new Set([
        "start",
        "text_start",
        "text_delta",
        "text_end",
        "thinking_start",
        "thinking_delta",
        "thinking_end",
        "toolcall_start",
        "toolcall_delta",
        "toolcall_end",
        "done",
        "error",
      ]);
      if (typeof updateType !== "string" || !supportedUpdates.has(updateType)) {
        return "message_update has an unsupported assistantMessageEvent type";
      }
      if (
        (updateType === "text_delta" || updateType === "thinking_delta") &&
        typeof update.delta !== "string"
      ) {
        return `${updateType} requires delta`;
      }
      return null;
    }
    case "tool_execution_start":
      return isNonEmptyString(record.toolCallId) &&
        isNonEmptyString(record.toolName) &&
        hasRecord(record, "args")
        ? null
        : "tool_execution_start requires toolCallId, toolName, and args";
    case "tool_execution_update":
      return isNonEmptyString(record.toolCallId) &&
        isNonEmptyString(record.toolName) &&
        hasRecord(record, "args") &&
        hasRecord(record, "partialResult")
        ? null
        : "tool_execution_update requires tool identity, args, and partialResult";
    case "tool_execution_end":
      return isNonEmptyString(record.toolCallId) &&
        isNonEmptyString(record.toolName) &&
        hasRecord(record, "result") &&
        typeof record.isError === "boolean"
        ? null
        : "tool_execution_end requires tool identity, result, and isError";
    case "queue_update":
      return hasArray(record, "steering") && hasArray(record, "followUp")
        ? null
        : "queue_update requires steering and followUp";
    case "compaction_start":
      return ["manual", "threshold", "overflow"].includes(String(record.reason))
        ? null
        : "compaction_start requires a known reason";
    case "compaction_end":
      return ["manual", "threshold", "overflow"].includes(String(record.reason)) &&
        typeof record.aborted === "boolean" &&
        typeof record.willRetry === "boolean"
        ? null
        : "compaction_end requires reason, aborted, and willRetry";
    case "auto_retry_start":
      return typeof record.attempt === "number" &&
        typeof record.maxAttempts === "number" &&
        typeof record.delayMs === "number" &&
        typeof record.errorMessage === "string"
        ? null
        : "auto_retry_start requires retry details";
    case "auto_retry_end":
      return typeof record.success === "boolean" && typeof record.attempt === "number"
        ? null
        : "auto_retry_end requires success and attempt";
    case "extension_error":
      return isNonEmptyString(record.extensionPath) &&
        isNonEmptyString(record.event) &&
        typeof record.error === "string"
        ? null
        : "extension_error requires extensionPath, event, and error";
  }
}

function validateExtensionUIRequest(record: Record<string, unknown>): string | null {
  if (!isNonEmptyString(record.id) || !isNonEmptyString(record.method)) {
    return "extension_ui_request requires id and method";
  }
  switch (record.method) {
    case "select":
      return typeof record.title === "string" && hasArray(record, "options")
        ? null
        : "select requires title and options";
    case "confirm":
      return typeof record.title === "string" && typeof record.message === "string"
        ? null
        : "confirm requires title and message";
    case "input":
    case "editor":
      return typeof record.title === "string" ? null : `${record.method} requires title`;
    case "notify":
      return typeof record.message === "string" ? null : "notify requires message";
    case "setStatus":
      return typeof record.statusKey === "string" ? null : "setStatus requires statusKey";
    case "setWidget":
      return typeof record.widgetKey === "string" ? null : "setWidget requires widgetKey";
    case "setTitle":
      return typeof record.title === "string" ? null : "setTitle requires title";
    case "set_editor_text":
      return typeof record.text === "string" ? null : "set_editor_text requires text";
    default:
      return `unsupported extension UI method: ${record.method}`;
  }
}

export function decodePiRpcOutputRecord(value: unknown): PiRpcOutputDecodeResult {
  if (!isRecord(value) || typeof value.type !== "string") {
    return {
      ok: false,
      error: { code: "invalid_envelope", message: "Pi RPC output must be an object with a type" },
    };
  }

  if (value.type === "response") {
    if (
      typeof value.command !== "string" ||
      typeof value.success !== "boolean" ||
      (value.id !== undefined && !isNonEmptyString(value.id)) ||
      (value.success === false && typeof value.error !== "string")
    ) {
      return {
        ok: false,
        error: { code: "invalid_response", message: "Invalid Pi RPC response envelope" },
      };
    }
    return { ok: true, record: value as unknown as PiRpcResponse };
  }

  if (value.type === "extension_ui_request") {
    const error = validateExtensionUIRequest(value);
    return error === null
      ? { ok: true, record: value as unknown as PiRpcExtensionUIRequest }
      : { ok: false, error: { code: "invalid_event", message: error } };
  }

  if ((PI_RPC_AGENT_EVENT_TYPES as ReadonlyArray<string>).includes(value.type)) {
    const eventType = value.type as PiRpcAgentEventType;
    const error = validateAgentEvent(value, eventType);
    return error === null
      ? { ok: true, record: value as unknown as PiRpcAgentEvent }
      : { ok: false, error: { code: "invalid_event", message: error, recordType: eventType } };
  }

  return {
    ok: false,
    error: {
      code: "unsupported_record_type",
      message: `Unsupported or unproven Pi RPC output type: ${value.type}`,
      recordType: value.type,
    },
  };
}

export function routePiRpcOutputRecord(record: PiRpcOutputRecord): PiRpcOutputRoute {
  if (record.type !== "response") {
    return { kind: "event", event: record };
  }
  return typeof record.id === "string"
    ? { kind: "response", requestId: record.id, response: record }
    : { kind: "uncorrelated_response", response: record };
}

function concatBytes(chunks: ReadonlyArray<Uint8Array>, byteLength: number): Uint8Array {
  if (chunks.length === 1 && chunks[0]?.byteLength === byteLength) {
    return chunks[0];
  }
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export class PiRpcRecordDecoder {
  readonly #maxRecordBytes: number;
  #chunks: Array<Uint8Array> = [];
  #byteLength = 0;
  #discardingOversizedRecord = false;

  constructor(options?: { readonly maxRecordBytes?: number }) {
    const maxRecordBytes = options?.maxRecordBytes ?? DEFAULT_PI_RPC_MAX_RECORD_BYTES;
    if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1) {
      throw new RangeError("maxRecordBytes must be a positive safe integer");
    }
    this.#maxRecordBytes = maxRecordBytes;
  }

  push(chunk: Uint8Array | string): ReadonlyArray<PiRpcFrame> {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    const frames: Array<PiRpcFrame> = [];
    let segmentStart = 0;

    for (let index = 0; index < bytes.byteLength; index += 1) {
      if (bytes[index] !== 0x0a) {
        continue;
      }
      this.#append(bytes.subarray(segmentStart, index), frames);
      if (!this.#discardingOversizedRecord) {
        frames.push(this.#decodeBufferedRecord());
      }
      this.#resetRecord();
      segmentStart = index + 1;
    }

    this.#append(bytes.subarray(segmentStart), frames);
    return frames;
  }

  finish(): ReadonlyArray<PiRpcFrame> {
    if (this.#discardingOversizedRecord || this.#byteLength === 0) {
      this.#resetRecord();
      return [];
    }
    const frame = this.#decodeBufferedRecord();
    this.#resetRecord();
    return [frame];
  }

  #append(segment: Uint8Array, frames: Array<PiRpcFrame>): void {
    if (segment.byteLength === 0 || this.#discardingOversizedRecord) {
      return;
    }
    const nextByteLength = this.#byteLength + segment.byteLength;
    if (nextByteLength > this.#maxRecordBytes) {
      frames.push({
        ok: false,
        error: {
          code: "record_too_large",
          message: `Pi RPC record exceeded ${this.#maxRecordBytes} bytes`,
          byteLength: nextByteLength,
        },
      });
      this.#chunks = [];
      this.#byteLength = 0;
      this.#discardingOversizedRecord = true;
      return;
    }
    this.#chunks.push(segment.slice());
    this.#byteLength = nextByteLength;
  }

  #decodeBufferedRecord(): PiRpcFrame {
    let bytes = concatBytes(this.#chunks, this.#byteLength);
    const wireByteLength = bytes.byteLength;
    if (bytes.at(-1) === 0x0d) {
      bytes = bytes.subarray(0, -1);
    }
    if (bytes.byteLength === 0) {
      return {
        ok: false,
        error: {
          code: "empty_record",
          message: "Pi RPC record is empty",
          byteLength: wireByteLength,
        },
      };
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return {
        ok: false,
        error: {
          code: "invalid_utf8",
          message: "Pi RPC record is not valid UTF-8",
          byteLength: wireByteLength,
        },
      };
    }

    try {
      return { ok: true, value: JSON.parse(text), byteLength: wireByteLength };
    } catch {
      return {
        ok: false,
        error: {
          code: "invalid_json",
          message: "Pi RPC record is not valid JSON",
          byteLength: wireByteLength,
        },
      };
    }
  }

  #resetRecord(): void {
    this.#chunks = [];
    this.#byteLength = 0;
    this.#discardingOversizedRecord = false;
  }
}

export function serializePiRpcInputRecord(
  record: PiRpcInputRecord,
  options?: { readonly maxRecordBytes?: number },
): string {
  let json: string;
  try {
    json = JSON.stringify(record);
  } catch (error) {
    throw new TypeError(`Pi RPC input record is not JSON serializable: ${String(error)}`, {
      cause: error,
    });
  }
  const byteLength = new TextEncoder().encode(json).byteLength;
  const maxRecordBytes = options?.maxRecordBytes ?? DEFAULT_PI_RPC_MAX_RECORD_BYTES;
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1) {
    throw new RangeError("maxRecordBytes must be a positive safe integer");
  }
  if (byteLength > maxRecordBytes) {
    throw new RangeError(`Pi RPC input record exceeded ${maxRecordBytes} bytes`);
  }
  return `${json}\n`;
}

export interface PiRpcDiagnosticSnapshot {
  readonly text: string;
  readonly totalBytes: number;
  readonly retainedBytes: number;
  readonly truncated: boolean;
}

export class PiRpcBoundedStderr {
  readonly #maxBytes: number;
  #bytes = new Uint8Array();
  #totalBytes = 0;

  constructor(options?: { readonly maxBytes?: number }) {
    const maxBytes = options?.maxBytes ?? DEFAULT_PI_RPC_MAX_STDERR_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError("maxBytes must be a positive safe integer");
    }
    this.#maxBytes = maxBytes;
  }

  append(chunk: Uint8Array | string): void {
    const incoming = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    this.#totalBytes += incoming.byteLength;
    const combined = new Uint8Array(this.#bytes.byteLength + incoming.byteLength);
    combined.set(this.#bytes);
    combined.set(incoming, this.#bytes.byteLength);
    this.#bytes =
      combined.byteLength <= this.#maxBytes
        ? combined
        : combined.slice(combined.byteLength - this.#maxBytes);
  }

  snapshot(): PiRpcDiagnosticSnapshot {
    return {
      text: new TextDecoder("utf-8").decode(this.#bytes),
      totalBytes: this.#totalBytes,
      retainedBytes: this.#bytes.byteLength,
      truncated: this.#totalBytes > this.#bytes.byteLength,
    };
  }
}
