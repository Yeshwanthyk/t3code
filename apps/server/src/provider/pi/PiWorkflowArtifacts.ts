// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const PI_WORKFLOW_ARTIFACT_VERSION = 1 as const;
export const DEFAULT_PI_WORKFLOW_MAX_BYTES = 1024 * 1024;
export const DEFAULT_PI_WORKFLOW_TRANSCRIPTS_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_PI_WORKFLOW_RESULT_MAX_BYTES = 1024 * 1024;
export const DEFAULT_PI_WORKFLOW_SCRIPT_MAX_BYTES = 1024 * 1024;

export const PI_WORKFLOW_STATUSES = ["running", "completed", "failed", "aborted"] as const;
export type PiWorkflowStatus = (typeof PI_WORKFLOW_STATUSES)[number];

export type PiWorkflowAgentState = "queued" | "running" | "done" | "error";
export type PiWorkflowThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface PiWorkflowTranscriptEntry {
  readonly role: "user" | "assistant" | "thinking" | "tool" | "toolResult";
  readonly text: string;
  readonly name?: string;
  readonly toolCallId?: string;
  readonly isError?: boolean;
  readonly timestamp?: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly durationMs?: number;
}

export interface PiWorkflowAgentSnapshot {
  readonly index: number;
  readonly label: string;
  readonly phase?: string;
  readonly state: PiWorkflowAgentState;
  readonly model?: string;
  readonly thinkingLevel?: PiWorkflowThinkingLevel;
  readonly queuedAt: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly error?: string;
  readonly preview: string;
  readonly usage: Readonly<Record<string, number | boolean>>;
  readonly transcript: ReadonlyArray<PiWorkflowTranscriptEntry>;
}

export interface PiWorkflowArtifactSnapshot {
  readonly version: typeof PI_WORKFLOW_ARTIFACT_VERSION;
  readonly providerInstanceId: string;
  readonly piAgentDir: string;
  readonly runId: string;
  readonly sessionId?: string;
  readonly name?: string;
  readonly description?: string;
  readonly background: boolean;
  readonly status: PiWorkflowStatus;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly finishedAt?: number;
  readonly phases: ReadonlyArray<{ readonly title: string; readonly detail?: string }>;
  readonly currentPhase?: string;
  readonly agents: ReadonlyArray<PiWorkflowAgentSnapshot>;
  readonly result?: unknown;
  readonly scriptText?: string;
  readonly error?: string;
  readonly revision: string;
}

export type PiWorkflowArtifactIssueCode =
  | "invalid_run_id"
  | "missing"
  | "unsafe_path"
  | "too_large"
  | "unstable_read"
  | "invalid_json"
  | "invalid_artifact"
  | "terminal_regression"
  | "stale_update";

export interface PiWorkflowArtifactIssue {
  readonly code: PiWorkflowArtifactIssueCode;
  readonly message: string;
}

export type PiWorkflowArtifactReadResult =
  | { readonly kind: "updated"; readonly snapshot: PiWorkflowArtifactSnapshot }
  | { readonly kind: "unchanged"; readonly snapshot: PiWorkflowArtifactSnapshot }
  | {
      readonly kind: "stale";
      readonly snapshot: PiWorkflowArtifactSnapshot;
      readonly issue: PiWorkflowArtifactIssue;
    }
  | { readonly kind: "unavailable"; readonly issue: PiWorkflowArtifactIssue };

export interface PiWorkflowArtifactReaderOptions {
  readonly providerInstanceId: string;
  readonly piAgentDir: string;
  readonly maxWorkflowBytes?: number;
  readonly maxTranscriptsBytes?: number;
  readonly maxResultBytes?: number;
  readonly maxScriptBytes?: number;
}

interface ArtifactLimits {
  readonly workflow: number;
  readonly transcripts: number;
  readonly result: number;
  readonly script: number;
}

interface FileSignature {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}

type StableRead =
  | { readonly ok: true; readonly text: string; readonly signature: FileSignature }
  | { readonly ok: false; readonly issue: PiWorkflowArtifactIssue };

type CandidateRead =
  | { readonly ok: true; readonly snapshot: PiWorkflowArtifactSnapshot }
  | { readonly ok: false; readonly issue: PiWorkflowArtifactIssue };

const RUN_ID_PATTERN = /^wf_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;
const THINKING_LEVELS = new Set<PiWorkflowThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const AGENT_STATES = new Set<PiWorkflowAgentState>(["queued", "running", "done", "error"]);
const TRANSCRIPT_ROLES = new Set(["user", "assistant", "thinking", "tool", "toolResult"]);
const WORKFLOW_STATUSES = new Set<unknown>(PI_WORKFLOW_STATUSES);
const USAGE_FIELDS = new Set([
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "cost",
  "outputComplete",
  "costComplete",
  "contextTokens",
  "turns",
]);

function issue(code: PiWorkflowArtifactIssueCode, message: string): PiWorkflowArtifactIssue {
  return { code, message };
}

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
  return isFiniteNonNegative(value) && value <= MAX_DATE_TIMESTAMP_MS;
}

function validLimit(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1)
    throw new RangeError("artifact limits must be positive");
  return result;
}

function signature(stat: NodeFS.Stats): FileSignature {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}

function sameSignature(left: FileSignature, right: FileSignature): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function readStableRegularFile(filePath: string, maxBytes: number): StableRead {
  let before: NodeFS.Stats;
  try {
    before = NodeFS.lstatSync(filePath);
  } catch {
    return {
      ok: false,
      issue: issue("missing", `artifact file is unavailable: ${NodePath.basename(filePath)}`),
    };
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    return {
      ok: false,
      issue: issue("unsafe_path", "artifact must be a regular non-symlink file"),
    };
  }
  if (before.size > maxBytes) {
    return { ok: false, issue: issue("too_large", `artifact exceeds ${maxBytes} bytes`) };
  }
  let text: string;
  try {
    text = NodeFS.readFileSync(filePath, "utf8");
  } catch {
    return { ok: false, issue: issue("unstable_read", "artifact could not be read completely") };
  }
  let after: NodeFS.Stats;
  try {
    after = NodeFS.lstatSync(filePath);
  } catch {
    return { ok: false, issue: issue("unstable_read", "artifact changed while it was read") };
  }
  const beforeSignature = signature(before);
  const afterSignature = signature(after);
  if (!sameSignature(beforeSignature, afterSignature)) {
    return { ok: false, issue: issue("unstable_read", "artifact changed while it was read") };
  }
  return { ok: true, text, signature: afterSignature };
}

function parseJson(
  text: string,
  name: string,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly issue: PiWorkflowArtifactIssue } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, issue: issue("invalid_json", `${name} is not complete valid JSON`) };
  }
}

function decodeTranscriptEntry(value: unknown): PiWorkflowTranscriptEntry | undefined {
  if (!isRecord(value) || typeof value.text !== "string") return undefined;
  if (!TRANSCRIPT_ROLES.has(String(value.role))) {
    return undefined;
  }
  const timestampFields = ["timestamp", "startedAt", "finishedAt"] as const;
  if (
    timestampFields.some((field) => value[field] !== undefined && !isTimestamp(value[field])) ||
    (value.durationMs !== undefined && !isFiniteNonNegative(value.durationMs))
  ) {
    return undefined;
  }
  if (
    (value.name !== undefined && typeof value.name !== "string") ||
    (value.toolCallId !== undefined && typeof value.toolCallId !== "string") ||
    (value.isError !== undefined && typeof value.isError !== "boolean")
  ) {
    return undefined;
  }
  return {
    role: value.role as PiWorkflowTranscriptEntry["role"],
    text: value.text,
    ...(value.name === undefined ? {} : { name: value.name }),
    ...(value.toolCallId === undefined ? {} : { toolCallId: value.toolCallId }),
    ...(value.isError === undefined ? {} : { isError: value.isError }),
    ...(value.timestamp === undefined ? {} : { timestamp: value.timestamp as number }),
    ...(value.startedAt === undefined ? {} : { startedAt: value.startedAt as number }),
    ...(value.finishedAt === undefined ? {} : { finishedAt: value.finishedAt as number }),
    ...(value.durationMs === undefined ? {} : { durationMs: value.durationMs as number }),
  };
}

function decodeTranscripts(value: unknown):
  | {
      readonly ok: true;
      readonly transcripts: ReadonlyMap<number, ReadonlyArray<PiWorkflowTranscriptEntry>>;
    }
  | { readonly ok: false; readonly issue: PiWorkflowArtifactIssue } {
  if (!isRecord(value)) {
    return { ok: false, issue: issue("invalid_artifact", "transcripts.json must be an object") };
  }
  const transcripts = new Map<number, ReadonlyArray<PiWorkflowTranscriptEntry>>();
  let entryCount = 0;
  for (const [key, rawEntries] of Object.entries(value)) {
    const agentIndex = Number(key);
    if (!/^\d+$/.test(key) || !Number.isSafeInteger(agentIndex) || !Array.isArray(rawEntries)) {
      return {
        ok: false,
        issue: issue("invalid_artifact", "transcripts.json has an invalid agent entry"),
      };
    }
    const entries: Array<PiWorkflowTranscriptEntry> = [];
    for (const rawEntry of rawEntries) {
      const entry = decodeTranscriptEntry(rawEntry);
      if (!entry || ++entryCount > 10_000) {
        return {
          ok: false,
          issue: issue("invalid_artifact", "transcripts.json has invalid or excessive entries"),
        };
      }
      entries.push(entry);
    }
    transcripts.set(agentIndex, entries);
  }
  return { ok: true, transcripts };
}

function decodeUsage(value: unknown): Readonly<Record<string, number | boolean>> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, number | boolean> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!USAGE_FIELDS.has(key)) return undefined;
    if (typeof item === "boolean") result[key] = item;
    else if (isFiniteNonNegative(item)) result[key] = item;
    else return undefined;
  }
  return result;
}

function decodeAgents(
  value: unknown,
  transcripts: ReadonlyMap<number, ReadonlyArray<PiWorkflowTranscriptEntry>>,
): ReadonlyArray<PiWorkflowAgentSnapshot> | undefined {
  if (!Array.isArray(value) || value.length > 1_000) return undefined;
  const agents: Array<PiWorkflowAgentSnapshot> = [];
  const seen = new Set<number>();
  for (const raw of value) {
    if (!isRecord(raw) || !Number.isSafeInteger(raw.index) || (raw.index as number) < 0)
      return undefined;
    const index = raw.index as number;
    const usage = decodeUsage(raw.usage);
    if (
      seen.has(index) ||
      !isNonEmptyString(raw.label) ||
      !AGENT_STATES.has(raw.state as PiWorkflowAgentState) ||
      !isTimestamp(raw.queuedAt) ||
      typeof raw.preview !== "string" ||
      !usage
    ) {
      return undefined;
    }
    seen.add(index);
    if (
      (raw.phase !== undefined && typeof raw.phase !== "string") ||
      (raw.model !== undefined && typeof raw.model !== "string") ||
      (raw.thinkingLevel !== undefined &&
        !THINKING_LEVELS.has(raw.thinkingLevel as PiWorkflowThinkingLevel)) ||
      (raw.startedAt !== undefined && !isTimestamp(raw.startedAt)) ||
      (raw.finishedAt !== undefined && !isTimestamp(raw.finishedAt)) ||
      (raw.error !== undefined && typeof raw.error !== "string")
    ) {
      return undefined;
    }
    agents.push({
      index,
      label: raw.label,
      state: raw.state as PiWorkflowAgentState,
      queuedAt: raw.queuedAt,
      preview: raw.preview,
      usage,
      transcript: transcripts.get(index) ?? [],
      ...(raw.phase === undefined ? {} : { phase: raw.phase }),
      ...(raw.model === undefined ? {} : { model: raw.model }),
      ...(raw.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: raw.thinkingLevel as PiWorkflowThinkingLevel }),
      ...(raw.startedAt === undefined ? {} : { startedAt: raw.startedAt }),
      ...(raw.finishedAt === undefined ? {} : { finishedAt: raw.finishedAt }),
      ...(raw.error === undefined ? {} : { error: raw.error }),
    });
  }
  return agents;
}

function decodePhases(value: unknown) {
  if (!Array.isArray(value) || value.length > 1_000) return undefined;
  const phases: Array<{ readonly title: string; readonly detail?: string }> = [];
  for (const raw of value) {
    if (
      !isRecord(raw) ||
      !isNonEmptyString(raw.title) ||
      (raw.detail !== undefined && typeof raw.detail !== "string")
    ) {
      return undefined;
    }
    phases.push({ title: raw.title, ...(raw.detail === undefined ? {} : { detail: raw.detail }) });
  }
  return phases;
}

function revisionPart(name: string, value: FileSignature | undefined): string {
  return value
    ? `${name}:${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}`
    : `${name}:none`;
}

function readCandidate(input: {
  readonly providerInstanceId: string;
  readonly piAgentDir: string;
  readonly workflowsDir: string;
  readonly runId: string;
  readonly limits: ArtifactLimits;
}): CandidateRead {
  if (!RUN_ID_PATTERN.test(input.runId)) {
    return { ok: false, issue: issue("invalid_run_id", "workflow run id is invalid") };
  }
  const runDir = NodePath.join(input.workflowsDir, input.runId);
  let runStat: NodeFS.Stats;
  try {
    runStat = NodeFS.lstatSync(runDir);
  } catch {
    return { ok: false, issue: issue("missing", "workflow run directory is unavailable") };
  }
  if (!runStat.isDirectory() || runStat.isSymbolicLink()) {
    return {
      ok: false,
      issue: issue("unsafe_path", "workflow run path must be a non-symlink directory"),
    };
  }
  let canonicalRunDir: string;
  try {
    canonicalRunDir = NodeFS.realpathSync(runDir);
  } catch {
    return { ok: false, issue: issue("unsafe_path", "workflow run path cannot be resolved") };
  }
  if (NodePath.dirname(canonicalRunDir) !== input.workflowsDir) {
    return {
      ok: false,
      issue: issue("unsafe_path", "workflow run escaped the configured Pi root"),
    };
  }

  const workflowPath = NodePath.join(canonicalRunDir, "workflow.json");
  const workflowRead = readStableRegularFile(workflowPath, input.limits.workflow);
  if (!workflowRead.ok) return workflowRead;
  const parsedWorkflow = parseJson(workflowRead.text, "workflow.json");
  if (!parsedWorkflow.ok) return parsedWorkflow;
  if (!isRecord(parsedWorkflow.value)) {
    return { ok: false, issue: issue("invalid_artifact", "workflow.json must be an object") };
  }
  const workflow = parsedWorkflow.value;
  if (workflow.runId !== input.runId) {
    return {
      ok: false,
      issue: issue("invalid_artifact", "workflow run id does not match its directory"),
    };
  }
  if (workflow.transcriptArtifact !== "transcripts.json") {
    return {
      ok: false,
      issue: issue("invalid_artifact", "workflow must reference transcripts.json"),
    };
  }
  const transcriptsRead = readStableRegularFile(
    NodePath.join(canonicalRunDir, "transcripts.json"),
    input.limits.transcripts,
  );
  if (!transcriptsRead.ok) return transcriptsRead;
  const parsedTranscripts = parseJson(transcriptsRead.text, "transcripts.json");
  if (!parsedTranscripts.ok) return parsedTranscripts;
  const decodedTranscripts = decodeTranscripts(parsedTranscripts.value);
  if (!decodedTranscripts.ok) return decodedTranscripts;

  let result: unknown;
  let resultSignature: FileSignature | undefined;
  if (workflow.resultArtifact !== undefined) {
    if (workflow.resultArtifact !== "result.json") {
      return { ok: false, issue: issue("unsafe_path", "workflow result reference is not allowed") };
    }
    const resultRead = readStableRegularFile(
      NodePath.join(canonicalRunDir, "result.json"),
      input.limits.result,
    );
    if (!resultRead.ok) return resultRead;
    const parsedResult = parseJson(resultRead.text, "result.json");
    if (!parsedResult.ok) return parsedResult;
    result = parsedResult.value;
    resultSignature = resultRead.signature;
  } else if (workflow.result !== undefined) {
    result = workflow.result;
  }

  let scriptText: string | undefined;
  let scriptSignature: FileSignature | undefined;
  const scriptPath = NodePath.join(canonicalRunDir, "script.js");
  if (NodeFS.existsSync(scriptPath)) {
    const scriptRead = readStableRegularFile(scriptPath, input.limits.script);
    if (!scriptRead.ok) return scriptRead;
    scriptText = scriptRead.text;
    scriptSignature = scriptRead.signature;
  }

  const workflowAfter = readStableRegularFile(workflowPath, input.limits.workflow);
  if (!workflowAfter.ok || !sameSignature(workflowRead.signature, workflowAfter.signature)) {
    return {
      ok: false,
      issue: issue("unstable_read", "workflow.json changed during snapshot assembly"),
    };
  }

  if (!WORKFLOW_STATUSES.has(workflow.status)) {
    return { ok: false, issue: issue("invalid_artifact", "workflow status is invalid") };
  }
  if (
    typeof workflow.background !== "boolean" ||
    !isTimestamp(workflow.startedAt) ||
    (workflow.sessionId !== undefined && !isNonEmptyString(workflow.sessionId)) ||
    (workflow.name !== undefined && typeof workflow.name !== "string") ||
    (workflow.description !== undefined && typeof workflow.description !== "string") ||
    (workflow.currentPhase !== undefined && typeof workflow.currentPhase !== "string") ||
    (workflow.error !== undefined && typeof workflow.error !== "string")
  ) {
    return { ok: false, issue: issue("invalid_artifact", "workflow metadata is invalid") };
  }
  const terminal = workflow.status !== "running";
  if (
    (terminal && (!isTimestamp(workflow.finishedAt) || workflow.finishedAt < workflow.startedAt)) ||
    (!terminal && workflow.finishedAt !== undefined)
  ) {
    return {
      ok: false,
      issue: issue("invalid_artifact", "workflow settlement timestamp is invalid"),
    };
  }
  const phases = decodePhases(workflow.phases);
  const agents = decodeAgents(workflow.agents, decodedTranscripts.transcripts);
  if (!phases || !agents) {
    return { ok: false, issue: issue("invalid_artifact", "workflow phases or agents are invalid") };
  }
  const sessionId = workflow.sessionId as string | undefined;
  const name = workflow.name as string | undefined;
  const description = workflow.description as string | undefined;
  const finishedAt = workflow.finishedAt as number | undefined;
  const currentPhase = workflow.currentPhase as string | undefined;
  const workflowError = workflow.error as string | undefined;

  const revision = [
    revisionPart("workflow", workflowRead.signature),
    revisionPart("transcripts", transcriptsRead.signature),
    revisionPart("result", resultSignature),
    revisionPart("script", scriptSignature),
  ].join("|");
  return {
    ok: true,
    snapshot: {
      version: PI_WORKFLOW_ARTIFACT_VERSION,
      providerInstanceId: input.providerInstanceId,
      piAgentDir: input.piAgentDir,
      runId: input.runId,
      background: workflow.background as boolean,
      status: workflow.status as PiWorkflowStatus,
      startedAt: workflow.startedAt as number,
      updatedAt: workflowRead.signature.mtimeMs,
      phases,
      agents,
      revision,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      ...(finishedAt === undefined ? {} : { finishedAt }),
      ...(currentPhase === undefined ? {} : { currentPhase }),
      ...(result === undefined ? {} : { result }),
      ...(scriptText === undefined ? {} : { scriptText }),
      ...(workflowError === undefined ? {} : { error: workflowError }),
    },
  };
}

function sameLogicalSnapshot(
  current: PiWorkflowArtifactSnapshot,
  candidate: PiWorkflowArtifactSnapshot,
): boolean {
  const { revision: _currentRevision, updatedAt: _currentUpdatedAt, ...currentValue } = current;
  const {
    revision: _candidateRevision,
    updatedAt: _candidateUpdatedAt,
    ...candidateValue
  } = candidate;
  return JSON.stringify(currentValue) === JSON.stringify(candidateValue);
}

export class PiWorkflowArtifactReader {
  readonly #providerInstanceId: string;
  readonly #piAgentDir: string;
  readonly #workflowsDir: string;
  readonly #limits: ArtifactLimits;
  readonly #snapshots = new Map<string, PiWorkflowArtifactSnapshot>();

  constructor(options: PiWorkflowArtifactReaderOptions) {
    if (!isNonEmptyString(options.providerInstanceId)) {
      throw new TypeError("providerInstanceId must be non-empty");
    }
    this.#providerInstanceId = options.providerInstanceId;
    this.#piAgentDir = NodePath.resolve(options.piAgentDir);
    const configuredWorkflowsDir = NodePath.join(this.#piAgentDir, "workflows");
    try {
      this.#workflowsDir = NodeFS.realpathSync(configuredWorkflowsDir);
    } catch {
      this.#workflowsDir = configuredWorkflowsDir;
    }
    this.#limits = {
      workflow: validLimit(options.maxWorkflowBytes, DEFAULT_PI_WORKFLOW_MAX_BYTES),
      transcripts: validLimit(
        options.maxTranscriptsBytes,
        DEFAULT_PI_WORKFLOW_TRANSCRIPTS_MAX_BYTES,
      ),
      result: validLimit(options.maxResultBytes, DEFAULT_PI_WORKFLOW_RESULT_MAX_BYTES),
      script: validLimit(options.maxScriptBytes, DEFAULT_PI_WORKFLOW_SCRIPT_MAX_BYTES),
    };
  }

  read(runId: string): PiWorkflowArtifactReadResult {
    const current = this.#snapshots.get(runId);
    const candidate = readCandidate({
      providerInstanceId: this.#providerInstanceId,
      piAgentDir: this.#piAgentDir,
      workflowsDir: this.#workflowsDir,
      runId,
      limits: this.#limits,
    });
    if (!candidate.ok) {
      return current
        ? { kind: "stale", snapshot: current, issue: candidate.issue }
        : { kind: "unavailable", issue: candidate.issue };
    }
    if (current === undefined) {
      this.#snapshots.set(runId, candidate.snapshot);
      return { kind: "updated", snapshot: candidate.snapshot };
    }
    if (
      current.revision === candidate.snapshot.revision ||
      sameLogicalSnapshot(current, candidate.snapshot)
    ) {
      return { kind: "unchanged", snapshot: current };
    }
    if (current.status !== "running") {
      return {
        kind: "stale",
        snapshot: current,
        issue: issue("terminal_regression", "terminal workflow snapshot is immutable"),
      };
    }
    if (candidate.snapshot.startedAt !== current.startedAt) {
      return {
        kind: "stale",
        snapshot: current,
        issue: issue("stale_update", "workflow creation identity changed"),
      };
    }
    this.#snapshots.set(runId, candidate.snapshot);
    return { kind: "updated", snapshot: candidate.snapshot };
  }

  listRunIds(): ReadonlyArray<string> {
    let names: ReadonlyArray<string>;
    try {
      names = NodeFS.readdirSync(this.#workflowsDir);
    } catch {
      return [];
    }
    return names.filter((name) => RUN_ID_PATTERN.test(name)).sort();
  }

  reconstruct(): ReadonlyArray<PiWorkflowArtifactSnapshot> {
    const snapshots: Array<PiWorkflowArtifactSnapshot> = [];
    for (const runId of this.listRunIds()) {
      const result = this.read(runId);
      if (result.kind !== "unavailable") snapshots.push(result.snapshot);
    }
    return snapshots.sort((left, right) => right.startedAt - left.startedAt);
  }
}
