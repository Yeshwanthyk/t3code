import {
  EventId,
  type ProviderRuntimeEvent,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { PiSubagentLineageManifest } from "./PiSubagentLineage.ts";

const PI_PROVIDER = ProviderDriverKind.make("pi");

export interface PiSubagentLineageProjectionContext {
  readonly providerInstanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly turnId?: TurnId;
}

function iso(timestamp: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(timestamp));
}

function eventId(
  manifest: PiSubagentLineageManifest,
  suffix: string,
  timestamp = manifest.timestamps.updatedAt,
): EventId {
  return EventId.make(
    `pi-subagent:${manifest.parentSessionId}:${manifest.runId}:${timestamp}:${suffix}`,
  );
}

function itemId(manifest: PiSubagentLineageManifest): RuntimeItemId {
  return RuntimeItemId.make(`pi-subagent:${manifest.parentSessionId}:${manifest.runId}`);
}

function taskId(manifest: PiSubagentLineageManifest): RuntimeTaskId {
  return RuntimeTaskId.make(`pi-subagent:${manifest.parentSessionId}:${manifest.runId}`);
}

function lineageData(manifest: PiSubagentLineageManifest): Record<string, unknown> {
  return {
    schemaVersion: manifest.version,
    runId: manifest.runId,
    parentProviderInstanceId: manifest.parentProviderInstanceId,
    parentSessionId: manifest.parentSessionId,
    childSessionId: manifest.childSessionId,
    childSessionFile: manifest.childSessionFile,
    backend: manifest.backend,
    model: manifest.model,
    thinkingLevel: manifest.thinkingLevel,
    resultRef: manifest.resultRef,
  };
}

function base(
  context: PiSubagentLineageProjectionContext,
  manifest: PiSubagentLineageManifest,
  suffix: string,
  timestamp: number,
) {
  return {
    eventId: eventId(manifest, suffix),
    provider: PI_PROVIDER,
    providerInstanceId: context.providerInstanceId,
    threadId: context.threadId,
    createdAt: iso(timestamp),
    ...(context.turnId === undefined ? {} : { turnId: context.turnId }),
  };
}

function startedEvents(
  context: PiSubagentLineageProjectionContext,
  manifest: PiSubagentLineageManifest,
): ReadonlyArray<ProviderRuntimeEvent> {
  const common = base(context, manifest, "started", manifest.timestamps.createdAt);
  return [
    {
      ...common,
      eventId: eventId(manifest, "item-started", manifest.timestamps.createdAt),
      itemId: itemId(manifest),
      type: "item.started",
      payload: {
        itemType: "collab_agent_tool_call",
        status: "inProgress",
        title: manifest.title,
        detail: manifest.taskSummary,
        data: lineageData(manifest),
      },
    },
    {
      ...common,
      eventId: eventId(manifest, "task-started", manifest.timestamps.createdAt),
      type: "task.started",
      payload: {
        taskId: taskId(manifest),
        description: manifest.taskSummary,
        taskType: `subagent:${manifest.backend}`,
      },
    },
  ];
}

function progressEvents(
  context: PiSubagentLineageProjectionContext,
  manifest: PiSubagentLineageManifest,
): ReadonlyArray<ProviderRuntimeEvent> {
  const common = base(context, manifest, "progress", manifest.timestamps.updatedAt);
  return [
    {
      ...common,
      eventId: eventId(manifest, "item-progress"),
      itemId: itemId(manifest),
      type: "item.updated",
      payload: {
        itemType: "collab_agent_tool_call",
        status: "inProgress",
        title: manifest.title,
        detail: manifest.taskSummary,
        data: lineageData(manifest),
      },
    },
    {
      ...common,
      eventId: eventId(manifest, "task-progress"),
      type: "task.progress",
      payload: {
        taskId: taskId(manifest),
        description: manifest.taskSummary,
        summary: manifest.title,
        ...(manifest.usage === undefined ? {} : { usage: manifest.usage }),
      },
    },
  ];
}

function terminalEvents(
  context: PiSubagentLineageProjectionContext,
  manifest: PiSubagentLineageManifest,
): ReadonlyArray<ProviderRuntimeEvent> {
  const common = base(context, manifest, "settled", manifest.timestamps.settledAt!);
  const successful = manifest.status === "completed";
  return [
    {
      ...common,
      eventId: eventId(manifest, "item-completed"),
      itemId: itemId(manifest),
      type: "item.completed",
      payload: {
        itemType: "collab_agent_tool_call",
        status: successful ? "completed" : "failed",
        title: manifest.title,
        detail: manifest.taskSummary,
        data: lineageData(manifest),
      },
    },
    {
      ...common,
      eventId: eventId(manifest, "task-completed"),
      type: "task.completed",
      payload: {
        taskId: taskId(manifest),
        status:
          manifest.status === "completed"
            ? "completed"
            : manifest.status === "aborted"
              ? "stopped"
              : "failed",
        summary: manifest.taskSummary,
        ...(manifest.usage === undefined ? {} : { usage: manifest.usage }),
      },
    },
  ];
}

/**
 * Projects an accepted authoritative lineage record onto T3's existing
 * collaboration-item and task activity seams. A terminal-only replay also
 * emits the missing start events so a latest-snapshot producer remains valid.
 */
export function projectPiSubagentLineageTransition(
  context: PiSubagentLineageProjectionContext,
  previous: PiSubagentLineageManifest | undefined,
  manifest: PiSubagentLineageManifest,
): ReadonlyArray<ProviderRuntimeEvent> {
  if (previous === undefined) {
    const started = startedEvents(context, manifest);
    return manifest.status === "running"
      ? started
      : [...started, ...terminalEvents(context, manifest)];
  }
  return manifest.status === "running"
    ? progressEvents(context, manifest)
    : terminalEvents(context, manifest);
}
