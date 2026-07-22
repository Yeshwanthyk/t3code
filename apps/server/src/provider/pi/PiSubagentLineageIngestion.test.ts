import {
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { PiSubagentLineageIngestion } from "./PiSubagentLineageIngestion.ts";
import type { PiSubagentLineageManifest } from "./PiSubagentLineage.ts";

function manifest(overrides: Partial<PiSubagentLineageManifest> = {}): PiSubagentLineageManifest {
  return {
    version: 1,
    parentProviderInstanceId: "pi-work",
    parentSessionId: "parent-native-session",
    runId: "run-a",
    childSessionId: "child-native-session",
    childSessionFile: "/redacted/pi/child.jsonl",
    backend: "pi",
    status: "running",
    title: "Trace the adapter",
    taskSummary: "Inspect the explicit provider boundary",
    timestamps: { createdAt: 1_000, updatedAt: 1_000 },
    ...overrides,
  };
}

function ingestion() {
  return new PiSubagentLineageIngestion({
    providerInstanceId: ProviderInstanceId.make("pi-work"),
    parentSessionId: "parent-native-session",
    threadId: ThreadId.make("thread-a"),
    turnId: TurnId.make("turn-a"),
  });
}

function eventTypes(events: ReadonlyArray<ProviderRuntimeEvent>): string[] {
  return events.map((event) => event.type);
}

describe("PiSubagentLineageIngestion", () => {
  it("projects explicit spawn, progress, and settlement through canonical seams", () => {
    const subject = ingestion();

    const spawned = subject.ingest(manifest());
    expect(spawned.kind).toBe("applied");
    if (spawned.kind !== "applied") return;
    expect(eventTypes(spawned.events)).toEqual(["item.started", "task.started"]);
    expect(spawned.events[0]).toMatchObject({
      type: "item.started",
      payload: {
        itemType: "collab_agent_tool_call",
        data: {
          runId: "run-a",
          childSessionId: "child-native-session",
          childSessionFile: "/redacted/pi/child.jsonl",
        },
      },
    });

    const progress = subject.ingest(
      manifest({
        taskSummary: "Child is replaying provider events",
        timestamps: { createdAt: 1_000, updatedAt: 2_000 },
        usage: { totalTokens: 12 },
      }),
    );
    expect(progress.kind).toBe("applied");
    if (progress.kind !== "applied") return;
    expect(eventTypes(progress.events)).toEqual(["item.updated", "task.progress"]);

    const settled = subject.ingest(
      manifest({
        status: "completed",
        timestamps: { createdAt: 1_000, updatedAt: 3_000, settledAt: 3_000 },
        resultRef: "results/run-a.json",
      }),
    );
    expect(settled.kind).toBe("applied");
    if (settled.kind !== "applied") return;
    expect(eventTypes(settled.events)).toEqual(["item.completed", "task.completed"]);
    expect(settled.events[1]).toMatchObject({
      type: "task.completed",
      payload: { status: "completed" },
    });
  });

  it("is idempotent and never regresses a terminal record", () => {
    const subject = ingestion();
    const terminal = manifest({
      status: "aborted",
      timestamps: { createdAt: 1_000, updatedAt: 2_000, settledAt: 2_000 },
    });

    const first = subject.ingest(terminal);
    expect(first.kind).toBe("applied");
    if (first.kind !== "applied") return;
    expect(eventTypes(first.events)).toEqual([
      "item.started",
      "task.started",
      "item.completed",
      "task.completed",
    ]);
    expect(first.events[3]).toMatchObject({ payload: { status: "stopped" } });

    expect(subject.ingest(terminal)).toMatchObject({ kind: "unchanged", events: [] });
    expect(
      subject.ingest(manifest({ timestamps: { createdAt: 1_000, updatedAt: 3_000 } })),
    ).toMatchObject({ kind: "rejected", reason: "terminal lineage is immutable" });
    expect(subject.get("run-a")?.status).toBe("aborted");
  });

  it("uses stable start identities when restart replay begins from a terminal snapshot", () => {
    const live = ingestion().ingest(manifest());
    const replay = ingestion().ingest(
      manifest({
        status: "completed",
        timestamps: { createdAt: 1_000, updatedAt: 3_000, settledAt: 3_000 },
      }),
    );
    expect(live.kind).toBe("applied");
    expect(replay.kind).toBe("applied");
    if (live.kind !== "applied" || replay.kind !== "applied") return;
    expect(replay.events.slice(0, 2).map((event) => event.eventId)).toEqual(
      live.events.map((event) => event.eventId),
    );
  });

  it("rejects records for another provider instance or native parent session", () => {
    const subject = ingestion();
    expect(subject.ingest(manifest({ parentProviderInstanceId: "pi-personal" }))).toMatchObject({
      kind: "rejected",
      reason: "lineage manifest is outside the bound parent scope",
    });
    expect(subject.ingest(manifest({ parentSessionId: "other-parent" }))).toMatchObject({
      kind: "rejected",
      reason: "lineage manifest is outside the bound parent scope",
    });
    expect(subject.list()).toEqual([]);
  });

  it("rejects identity replacement without guessing from display metadata", () => {
    const subject = ingestion();
    expect(subject.ingest(manifest()).kind).toBe("applied");
    expect(
      subject.ingest(
        manifest({
          childSessionId: "replacement-child",
          title: "Same title",
          timestamps: { createdAt: 1_000, updatedAt: 2_000 },
        }),
      ),
    ).toMatchObject({ kind: "rejected", reason: "lineage identity is immutable" });
  });
});
