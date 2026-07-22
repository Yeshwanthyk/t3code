export const PI_SUBAGENT_LINEAGE_VERSION = 1 as const;

export const PI_SUBAGENT_BACKENDS = ["pi", "claude", "codex"] as const;
export type PiSubagentBackend = (typeof PI_SUBAGENT_BACKENDS)[number];

export const PI_SUBAGENT_STATUSES = ["running", "completed", "failed", "aborted"] as const;
export type PiSubagentStatus = (typeof PI_SUBAGENT_STATUSES)[number];

export const PI_SUBAGENT_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type PiSubagentThinkingLevel = (typeof PI_SUBAGENT_THINKING_LEVELS)[number];

export interface PiSubagentUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly totalTokens?: number;
  readonly costUsd?: number;
  readonly turns?: number;
}

export interface PiSubagentLineageManifest {
  readonly version: typeof PI_SUBAGENT_LINEAGE_VERSION;
  readonly parentProviderInstanceId: string;
  readonly parentSessionId: string;
  readonly runId: string;
  readonly childSessionId: string;
  readonly childSessionFile: string;
  readonly backend: PiSubagentBackend;
  readonly status: PiSubagentStatus;
  readonly title: string;
  readonly taskSummary: string;
  readonly model?: string;
  readonly thinkingLevel?: PiSubagentThinkingLevel;
  readonly timestamps: {
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly settledAt?: number;
  };
  readonly usage?: PiSubagentUsage;
  readonly resultRef?: string;
}

export type PiSubagentLineageDecodeResult =
  | { readonly ok: true; readonly manifest: PiSubagentLineageManifest }
  | { readonly ok: false; readonly reason: string };

export type PiSubagentLineageTransition =
  | { readonly kind: "applied"; readonly manifest: PiSubagentLineageManifest }
  | { readonly kind: "unchanged"; readonly manifest: PiSubagentLineageManifest }
  | {
      readonly kind: "rejected";
      readonly manifest: PiSubagentLineageManifest;
      readonly reason: string;
    };

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 8_640_000_000_000_000
  );
}

function isOptionalFiniteNonNegative(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNonNegative(value);
}

function isSafeResultRef(value: unknown): value is string | undefined {
  if (value === undefined) return true;
  if (!isNonEmptyString(value) || value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) {
    return false;
  }
  return !value.split(/[\\/]/).some((segment) => segment === "" || segment === "..");
}

function decodeUsage(value: unknown): PiSubagentUsage | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const fields = [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "totalTokens",
    "costUsd",
    "turns",
  ] as const;
  if (fields.some((field) => !isOptionalFiniteNonNegative(value[field]))) return null;
  return Object.fromEntries(
    fields.filter((field) => value[field] !== undefined).map((field) => [field, value[field]]),
  ) as PiSubagentUsage;
}

export function decodePiSubagentLineageManifest(value: unknown): PiSubagentLineageDecodeResult {
  if (!isRecord(value)) return { ok: false, reason: "lineage manifest must be an object" };
  if (value.version !== PI_SUBAGENT_LINEAGE_VERSION) {
    return { ok: false, reason: "unsupported lineage manifest version" };
  }
  if (
    !isNonEmptyString(value.parentProviderInstanceId) ||
    !isNonEmptyString(value.parentSessionId) ||
    !isNonEmptyString(value.runId) ||
    !RUN_ID_PATTERN.test(value.runId) ||
    !isNonEmptyString(value.childSessionId) ||
    !isNonEmptyString(value.childSessionFile) ||
    !isNonEmptyString(value.title) ||
    !isNonEmptyString(value.taskSummary)
  ) {
    return { ok: false, reason: "lineage manifest has invalid required identity or task fields" };
  }
  if (!(PI_SUBAGENT_BACKENDS as ReadonlyArray<unknown>).includes(value.backend)) {
    return { ok: false, reason: "lineage manifest has an unsupported backend" };
  }
  if (!(PI_SUBAGENT_STATUSES as ReadonlyArray<unknown>).includes(value.status)) {
    return { ok: false, reason: "lineage manifest has an unsupported status" };
  }
  if (value.model !== undefined && !isNonEmptyString(value.model)) {
    return { ok: false, reason: "lineage manifest model must be a non-empty string" };
  }
  if (
    value.thinkingLevel !== undefined &&
    !(PI_SUBAGENT_THINKING_LEVELS as ReadonlyArray<unknown>).includes(value.thinkingLevel)
  ) {
    return { ok: false, reason: "lineage manifest has an unsupported thinking level" };
  }
  if (!isRecord(value.timestamps)) {
    return { ok: false, reason: "lineage manifest timestamps must be an object" };
  }
  const { createdAt, updatedAt, settledAt } = value.timestamps;
  if (
    !isTimestamp(createdAt) ||
    !isTimestamp(updatedAt) ||
    updatedAt < createdAt ||
    !(settledAt === undefined || isTimestamp(settledAt))
  ) {
    return { ok: false, reason: "lineage manifest timestamps are invalid" };
  }
  const terminal = value.status !== "running";
  if (
    (terminal && (settledAt === undefined || settledAt < createdAt || settledAt > updatedAt)) ||
    (!terminal && settledAt !== undefined)
  ) {
    return { ok: false, reason: "lineage settlement timestamp does not match status" };
  }
  const usage = decodeUsage(value.usage);
  if (usage === null) return { ok: false, reason: "lineage manifest usage is invalid" };
  if (!isSafeResultRef(value.resultRef)) {
    return { ok: false, reason: "lineage manifest resultRef must be a safe relative reference" };
  }

  return {
    ok: true,
    manifest: {
      version: PI_SUBAGENT_LINEAGE_VERSION,
      parentProviderInstanceId: value.parentProviderInstanceId,
      parentSessionId: value.parentSessionId,
      runId: value.runId,
      childSessionId: value.childSessionId,
      childSessionFile: value.childSessionFile,
      backend: value.backend as PiSubagentBackend,
      status: value.status as PiSubagentStatus,
      title: value.title,
      taskSummary: value.taskSummary,
      ...(value.model === undefined ? {} : { model: value.model }),
      ...(value.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: value.thinkingLevel as PiSubagentThinkingLevel }),
      timestamps: {
        createdAt,
        updatedAt,
        ...(settledAt === undefined ? {} : { settledAt }),
      },
      ...(usage === undefined ? {} : { usage }),
      ...(value.resultRef === undefined ? {} : { resultRef: value.resultRef }),
    },
  };
}

function sameIdentity(
  current: PiSubagentLineageManifest,
  candidate: PiSubagentLineageManifest,
): boolean {
  return (
    current.version === candidate.version &&
    current.parentProviderInstanceId === candidate.parentProviderInstanceId &&
    current.parentSessionId === candidate.parentSessionId &&
    current.runId === candidate.runId &&
    current.childSessionId === candidate.childSessionId &&
    current.childSessionFile === candidate.childSessionFile &&
    current.backend === candidate.backend &&
    current.timestamps.createdAt === candidate.timestamps.createdAt
  );
}

export function applyPiSubagentLineageTransition(
  current: PiSubagentLineageManifest | undefined,
  candidate: PiSubagentLineageManifest,
): PiSubagentLineageTransition {
  if (current === undefined) return { kind: "applied", manifest: candidate };
  if (!sameIdentity(current, candidate)) {
    return { kind: "rejected", manifest: current, reason: "lineage identity is immutable" };
  }
  if (JSON.stringify(current) === JSON.stringify(candidate)) {
    return { kind: "unchanged", manifest: current };
  }
  if (current.status !== "running") {
    return { kind: "rejected", manifest: current, reason: "terminal lineage is immutable" };
  }
  if (candidate.status === "running") {
    if (candidate.timestamps.updatedAt <= current.timestamps.updatedAt) {
      return {
        kind: "rejected",
        manifest: current,
        reason: "running lineage update must advance updatedAt",
      };
    }
    return { kind: "applied", manifest: candidate };
  }
  if (candidate.timestamps.updatedAt < current.timestamps.updatedAt) {
    return { kind: "rejected", manifest: current, reason: "terminal lineage update is stale" };
  }
  return { kind: "applied", manifest: candidate };
}
