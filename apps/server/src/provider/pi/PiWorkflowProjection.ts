// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  EventId,
  type ProviderRuntimeEvent,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeTaskId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { PiWorkflowArtifactSnapshot } from "./PiWorkflowArtifacts.ts";
import type { PiWorkflowChange } from "./PiWorkflowWatcher.ts";

const PI_PROVIDER = ProviderDriverKind.make("pi");

function displayName(snapshot: PiWorkflowArtifactSnapshot): string {
  for (const candidate of [snapshot.name, snapshot.description]) {
    const normalized = candidate?.trim();
    if (normalized) return normalized;
  }
  return `Workflow ${snapshot.runId}`;
}

function aggregateUsage(snapshot: PiWorkflowArtifactSnapshot): Record<string, number | boolean> {
  const totals: Record<string, number | boolean> = {};
  for (const agent of snapshot.agents) {
    for (const [key, value] of Object.entries(agent.usage)) {
      if (typeof value === "number") {
        totals[key] = (typeof totals[key] === "number" ? totals[key] : 0) + value;
      } else if (typeof value === "boolean") {
        totals[key] = (typeof totals[key] === "boolean" ? totals[key] : true) && value;
      }
    }
  }
  return totals;
}

function progressSummary(snapshot: PiWorkflowArtifactSnapshot): string {
  const settledAgents = snapshot.agents.filter(
    (agent) => agent.state === "done" || agent.state === "error",
  ).length;
  const lifecycle = `${settledAgents}/${snapshot.agents.length} agents settled`;
  return snapshot.currentPhase ? `${snapshot.currentPhase} · ${lifecycle}` : lifecycle;
}

function terminalSummary(snapshot: PiWorkflowArtifactSnapshot): string {
  if (snapshot.error?.trim()) return snapshot.error.trim();
  if (snapshot.status === "aborted") return "Workflow aborted";
  if (snapshot.status === "failed") return "Workflow failed";
  return "Workflow completed";
}

function iso(timestamp: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(timestamp));
}

function revisionDigest(revision: string): string {
  return NodeCrypto.createHash("sha256").update(revision).digest("hex").slice(0, 20);
}

function base(
  snapshot: PiWorkflowArtifactSnapshot,
  threadId: ThreadId,
  eventSuffix: string,
  createdAt: number,
) {
  return {
    eventId: EventId.make(
      `pi-workflow:${snapshot.providerInstanceId}:${snapshot.runId}:${eventSuffix}`,
    ),
    provider: PI_PROVIDER,
    providerInstanceId: ProviderInstanceId.make(snapshot.providerInstanceId),
    threadId,
    createdAt: iso(createdAt),
    raw: {
      source: "pi.rpc" as const,
      method: "workflow.artifact",
      payload: {
        runId: snapshot.runId,
        nativeSessionId: snapshot.sessionId,
        status: snapshot.status,
        revision: revisionDigest(snapshot.revision),
      },
    },
  };
}

function startedEvent(
  snapshot: PiWorkflowArtifactSnapshot,
  threadId: ThreadId,
): ProviderRuntimeEvent {
  return {
    ...base(snapshot, threadId, "started", snapshot.startedAt),
    type: "task.started",
    payload: {
      taskId: RuntimeTaskId.make(`pi-workflow:${snapshot.providerInstanceId}:${snapshot.runId}`),
      description: displayName(snapshot),
      taskType: "workflow",
    },
  };
}

function progressEvent(
  snapshot: PiWorkflowArtifactSnapshot,
  threadId: ThreadId,
): ProviderRuntimeEvent {
  return {
    ...base(
      snapshot,
      threadId,
      `progress:${revisionDigest(snapshot.revision)}`,
      snapshot.updatedAt,
    ),
    type: "task.progress",
    payload: {
      taskId: RuntimeTaskId.make(`pi-workflow:${snapshot.providerInstanceId}:${snapshot.runId}`),
      description: displayName(snapshot),
      summary: progressSummary(snapshot),
      usage: aggregateUsage(snapshot),
    },
  };
}

function completedEvent(
  snapshot: PiWorkflowArtifactSnapshot,
  threadId: ThreadId,
): ProviderRuntimeEvent {
  const status =
    snapshot.status === "completed"
      ? ("completed" as const)
      : snapshot.status === "failed"
        ? ("failed" as const)
        : ("stopped" as const);
  return {
    ...base(
      snapshot,
      threadId,
      `completed:${snapshot.status}`,
      snapshot.finishedAt ?? snapshot.updatedAt,
    ),
    type: "task.completed",
    payload: {
      taskId: RuntimeTaskId.make(`pi-workflow:${snapshot.providerInstanceId}:${snapshot.runId}`),
      status,
      summary: terminalSummary(snapshot),
      usage: aggregateUsage(snapshot),
    },
  };
}

/**
 * Project one accepted artifact transition through T3's provider-neutral task
 * event seam. A reconstructed terminal run emits both start and completion so
 * activity replay never depends on an in-memory pre-restart title cache.
 */
export function projectPiWorkflowArtifactChange(input: {
  readonly previous?: PiWorkflowArtifactSnapshot;
  readonly current: PiWorkflowArtifactSnapshot;
  readonly threadId: ThreadId;
}): ReadonlyArray<ProviderRuntimeEvent> {
  if (input.previous === undefined) {
    return input.current.status === "running"
      ? [startedEvent(input.current, input.threadId), progressEvent(input.current, input.threadId)]
      : [
          startedEvent(input.current, input.threadId),
          completedEvent(input.current, input.threadId),
        ];
  }
  return input.current.status === "running"
    ? [progressEvent(input.current, input.threadId)]
    : [completedEvent(input.current, input.threadId)];
}

export function projectPiWorkflowChanges(
  changes: ReadonlyArray<PiWorkflowChange>,
  resolveThreadId: (input: {
    readonly providerInstanceId: string;
    readonly nativeSessionId: string;
  }) => ThreadId | undefined,
): {
  readonly events: ReadonlyArray<ProviderRuntimeEvent>;
  readonly unresolvedRunIds: ReadonlyArray<string>;
} {
  const events: Array<ProviderRuntimeEvent> = [];
  const unresolvedRunIds: Array<string> = [];
  for (const change of changes) {
    const nativeSessionId = change.current.sessionId;
    const threadId = nativeSessionId
      ? resolveThreadId({
          providerInstanceId: change.current.providerInstanceId,
          nativeSessionId,
        })
      : undefined;
    if (!threadId) {
      unresolvedRunIds.push(change.runId);
      continue;
    }
    events.push(
      ...projectPiWorkflowArtifactChange({
        ...(change.previous === undefined ? {} : { previous: change.previous }),
        current: change.current,
        threadId,
      }),
    );
  }
  return { events, unresolvedRunIds };
}
