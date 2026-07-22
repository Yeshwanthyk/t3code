// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import {
  PiWorkflowArtifactReader,
  type PiWorkflowArtifactIssue,
  type PiWorkflowArtifactReaderOptions,
  type PiWorkflowArtifactSnapshot,
} from "./PiWorkflowArtifacts.ts";

export interface PiWorkflowChange {
  readonly runId: string;
  readonly previous?: PiWorkflowArtifactSnapshot;
  readonly current: PiWorkflowArtifactSnapshot;
}

export interface PiWorkflowScanIssue extends PiWorkflowArtifactIssue {
  readonly runId: string;
}

export interface PiWorkflowScanResult {
  readonly changes: ReadonlyArray<PiWorkflowChange>;
  readonly issues: ReadonlyArray<PiWorkflowScanIssue>;
  readonly snapshots: ReadonlyArray<PiWorkflowArtifactSnapshot>;
}

interface CloseableWatch {
  readonly close: () => void;
}

export interface PiWorkflowWatcherOptions extends PiWorkflowArtifactReaderOptions {
  readonly pollIntervalMs?: number;
  readonly watchFactory?: (
    workflowsDir: string,
    onChange: () => void,
  ) => CloseableWatch | undefined;
  readonly pollFactory?: (onPoll: () => void, intervalMs: number) => (() => void) | undefined;
}

function defaultWatchFactory(
  workflowsDir: string,
  onChange: () => void,
): CloseableWatch | undefined {
  try {
    return NodeFS.watch(workflowsDir, { recursive: true }, onChange);
  } catch {
    try {
      return NodeFS.watch(workflowsDir, onChange);
    } catch {
      return undefined;
    }
  }
}

function defaultPollFactory(onPoll: () => void, intervalMs: number): () => void {
  const poller = Effect.runFork(
    Effect.sleep(Duration.millis(intervalMs)).pipe(
      Effect.andThen(Effect.sync(onPoll)),
      Effect.forever,
    ),
  );
  return () => {
    Effect.runFork(Fiber.interrupt(poller));
  };
}

export class PiWorkflowWatcher {
  readonly #reader: PiWorkflowArtifactReader;
  readonly #workflowsDir: string;
  readonly #pollIntervalMs: number;
  readonly #watchFactory: NonNullable<PiWorkflowWatcherOptions["watchFactory"]>;
  readonly #pollFactory: NonNullable<PiWorkflowWatcherOptions["pollFactory"]>;
  readonly #snapshots = new Map<string, PiWorkflowArtifactSnapshot>();
  readonly #lastIssues = new Map<string, string>();
  #stopWatching: (() => void) | undefined;

  constructor(options: PiWorkflowWatcherOptions) {
    this.#reader = new PiWorkflowArtifactReader(options);
    this.#workflowsDir = NodePath.join(NodePath.resolve(options.piAgentDir), "workflows");
    this.#pollIntervalMs = options.pollIntervalMs ?? 500;
    if (!Number.isSafeInteger(this.#pollIntervalMs) || this.#pollIntervalMs < 50) {
      throw new RangeError("pollIntervalMs must be an integer of at least 50 milliseconds");
    }
    this.#watchFactory = options.watchFactory ?? defaultWatchFactory;
    this.#pollFactory = options.pollFactory ?? defaultPollFactory;
  }

  get(runId: string): PiWorkflowArtifactSnapshot | undefined {
    return this.#snapshots.get(runId);
  }

  list(): ReadonlyArray<PiWorkflowArtifactSnapshot> {
    return [...this.#snapshots.values()].sort(
      (left, right) => right.startedAt - left.startedAt || left.runId.localeCompare(right.runId),
    );
  }

  scan(): PiWorkflowScanResult {
    const changes: Array<PiWorkflowChange> = [];
    const issues: Array<PiWorkflowScanIssue> = [];
    const runIds = new Set([...this.#reader.listRunIds(), ...this.#snapshots.keys()]);
    for (const runId of [...runIds].sort()) {
      const previous = this.#snapshots.get(runId);
      const result = this.#reader.read(runId);
      if (result.kind === "unavailable") {
        const fingerprint = `${result.issue.code}:${result.issue.message}`;
        if (this.#lastIssues.get(runId) !== fingerprint) {
          issues.push({ runId, ...result.issue });
          this.#lastIssues.set(runId, fingerprint);
        }
        continue;
      }
      if (result.kind === "stale") {
        const fingerprint = `${result.issue.code}:${result.issue.message}`;
        if (this.#lastIssues.get(runId) !== fingerprint) {
          issues.push({ runId, ...result.issue });
          this.#lastIssues.set(runId, fingerprint);
        }
        continue;
      }
      this.#lastIssues.delete(runId);
      if (result.kind === "unchanged") {
        if (!previous) this.#snapshots.set(runId, result.snapshot);
        continue;
      }
      this.#snapshots.set(runId, result.snapshot);
      changes.push({
        runId,
        ...(previous === undefined ? {} : { previous }),
        current: result.snapshot,
      });
    }
    return { changes, issues, snapshots: this.list() };
  }

  start(listener: (result: PiWorkflowScanResult) => void): void {
    if (this.#stopWatching) return;
    let queued = false;
    let stopped = false;
    const scan = () => {
      queued = false;
      if (!stopped) listener(this.scan());
    };
    const schedule = () => {
      if (queued || stopped) return;
      queued = true;
      queueMicrotask(scan);
    };
    const nativeWatch = this.#watchFactory(this.#workflowsDir, schedule);
    const stopPolling = this.#pollFactory(schedule, this.#pollIntervalMs);
    this.#stopWatching = () => {
      stopped = true;
      nativeWatch?.close();
      stopPolling?.();
      this.#stopWatching = undefined;
    };
    listener(this.scan());
  }

  stop(): void {
    this.#stopWatching?.();
  }
}

export const makeScopedPiWorkflowWatcher = Effect.fn("makeScopedPiWorkflowWatcher")(function* (
  options: PiWorkflowWatcherOptions,
) {
  return yield* Effect.acquireRelease(
    Effect.sync(() => new PiWorkflowWatcher(options)),
    (watcher) => Effect.sync(() => watcher.stop()),
  );
});
