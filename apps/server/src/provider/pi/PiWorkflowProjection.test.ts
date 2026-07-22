import {
  ProviderRuntimeEvent,
  ThreadId,
  type ProviderRuntimeEvent as ProviderRuntimeEventType,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import type { PiWorkflowArtifactSnapshot, PiWorkflowStatus } from "./PiWorkflowArtifacts.ts";
import {
  projectPiWorkflowArtifactChange,
  projectPiWorkflowChanges,
} from "./PiWorkflowProjection.ts";

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

function snapshot(
  status: PiWorkflowStatus,
  overrides: Partial<PiWorkflowArtifactSnapshot> = {},
): PiWorkflowArtifactSnapshot {
  return {
    version: 1,
    providerInstanceId: "pi-instance-a",
    piAgentDir: "/redacted/pi-agent",
    runId: "wf_0123456789ab",
    sessionId: "native-session-a",
    name: "Inspect artifacts",
    background: true,
    status,
    startedAt: 10,
    updatedAt: 15,
    ...(status === "running" ? {} : { finishedAt: 20 }),
    phases: [{ title: "Inspect" }],
    currentPhase: "Inspect",
    agents: [
      {
        index: 1,
        label: "reader",
        state: status === "running" ? "running" : status === "completed" ? "done" : "error",
        queuedAt: 10,
        preview: "reading",
        usage: { input: 3, output: 5, outputComplete: true },
        transcript: [],
      },
    ],
    ...(status === "failed" ? { error: "producer failed" } : {}),
    ...(status === "aborted" ? { error: "producer aborted" } : {}),
    revision: `revision-${status}`,
    ...overrides,
  };
}

function expectValidEvents(events: ReadonlyArray<ProviderRuntimeEventType>): void {
  for (const event of events) expect(() => decodeRuntimeEvent(event)).not.toThrow();
}

describe("projectPiWorkflowArtifactChange", () => {
  it("projects a new running artifact through canonical task start and progress", () => {
    const events = projectPiWorkflowArtifactChange({
      current: snapshot("running"),
      threadId: ThreadId.make("thread-a"),
    });

    expectValidEvents(events);
    expect(events.map((event) => event.type)).toEqual(["task.started", "task.progress"]);
    expect(events[0]).toMatchObject({
      provider: "pi",
      providerInstanceId: "pi-instance-a",
      threadId: "thread-a",
      payload: {
        taskId: "pi-workflow:pi-instance-a:wf_0123456789ab",
        description: "Inspect artifacts",
        taskType: "workflow",
      },
    });
    expect(events[1]).toMatchObject({
      payload: {
        summary: "Inspect · 0/1 agents settled",
        usage: { input: 3, output: 5, outputComplete: true },
      },
    });
  });

  it("reconstructs terminal artifacts with a title-bearing start before completion", () => {
    const expected = [
      ["completed", "completed"],
      ["failed", "failed"],
      ["aborted", "stopped"],
    ] as const;
    for (const [artifactStatus, taskStatus] of expected) {
      const events = projectPiWorkflowArtifactChange({
        current: snapshot(artifactStatus),
        threadId: ThreadId.make("thread-a"),
      });
      expectValidEvents(events);
      expect(events.map((event) => event.type)).toEqual(["task.started", "task.completed"]);
      expect(events[1]).toMatchObject({ payload: { status: taskStatus } });
    }
  });

  it("emits only progress or terminal activity for an accepted existing transition", () => {
    const running = snapshot("running");
    const progress = snapshot("running", { revision: "revision-progress", updatedAt: 16 });
    const completed = snapshot("completed");

    expect(
      projectPiWorkflowArtifactChange({
        previous: running,
        current: progress,
        threadId: ThreadId.make("thread-a"),
      }).map((event) => event.type),
    ).toEqual(["task.progress"]);
    expect(
      projectPiWorkflowArtifactChange({
        previous: running,
        current: completed,
        threadId: ThreadId.make("thread-a"),
      }).map((event) => event.type),
    ).toEqual(["task.completed"]);
  });
});

describe("projectPiWorkflowChanges", () => {
  it("requires an explicit native-session to T3-thread resolver", () => {
    const current = snapshot("running");
    const change = { runId: current.runId, current };

    expect(projectPiWorkflowChanges([change], () => undefined)).toEqual({
      events: [],
      unresolvedRunIds: ["wf_0123456789ab"],
    });
    expect(
      projectPiWorkflowChanges([change], ({ nativeSessionId }) =>
        nativeSessionId === "native-session-a" ? ThreadId.make("thread-a") : undefined,
      ).events,
    ).toHaveLength(2);
  });
});
