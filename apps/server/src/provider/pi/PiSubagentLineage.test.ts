import { describe, expect, it } from "vite-plus/test";

import {
  applyPiSubagentLineageTransition,
  decodePiSubagentLineageManifest,
  type PiSubagentLineageManifest,
} from "./PiSubagentLineage.ts";

function manifest(overrides: Partial<PiSubagentLineageManifest> = {}): PiSubagentLineageManifest {
  return {
    version: 1,
    parentProviderInstanceId: "pi-instance-a",
    parentSessionId: "parent-session-a",
    runId: "subagent-run-a",
    childSessionId: "child-session-a",
    childSessionFile: "/redacted/pi/session-a.jsonl",
    backend: "pi",
    status: "running",
    title: "Inspect provider boundary",
    taskSummary: "Trace the explicit child session identity",
    model: "provider/model",
    thinkingLevel: "high",
    timestamps: { createdAt: 10, updatedAt: 10 },
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, turns: 1 },
    ...overrides,
  };
}

describe("decodePiSubagentLineageManifest", () => {
  it("decodes the complete explicit lineage contract", () => {
    const decoded = decodePiSubagentLineageManifest(
      manifest({
        status: "completed",
        timestamps: { createdAt: 10, updatedAt: 20, settledAt: 20 },
        resultRef: "results/subagent-run-a.json",
      }),
    );

    expect(decoded).toMatchObject({
      ok: true,
      manifest: {
        parentProviderInstanceId: "pi-instance-a",
        parentSessionId: "parent-session-a",
        childSessionId: "child-session-a",
        childSessionFile: "/redacted/pi/session-a.jsonl",
        status: "completed",
      },
    });
  });

  it("rejects inferred, unsafe, or internally inconsistent lineage", () => {
    expect(
      decodePiSubagentLineageManifest({ ...manifest(), childSessionId: undefined }),
    ).toMatchObject({ ok: false });
    expect(
      decodePiSubagentLineageManifest({ ...manifest(), resultRef: "../other-run.json" }),
    ).toMatchObject({ ok: false });
    expect(
      decodePiSubagentLineageManifest({
        ...manifest(),
        status: "failed",
        timestamps: { createdAt: 10, updatedAt: 20 },
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("applyPiSubagentLineageTransition", () => {
  it("accepts ordered progress and one terminal transition", () => {
    const running = manifest();
    const progress = manifest({
      taskSummary: "Child session identified; replaying progress",
      timestamps: { createdAt: 10, updatedAt: 15 },
    });
    const completed = manifest({
      status: "completed",
      timestamps: { createdAt: 10, updatedAt: 20, settledAt: 20 },
      resultRef: "results/subagent-run-a.json",
    });

    expect(applyPiSubagentLineageTransition(running, progress)).toMatchObject({
      kind: "applied",
    });
    expect(applyPiSubagentLineageTransition(progress, completed)).toMatchObject({
      kind: "applied",
      manifest: { status: "completed" },
    });
  });

  it("makes duplicate terminal settlement idempotent and rejects every regression", () => {
    const completed = manifest({
      status: "completed",
      timestamps: { createdAt: 10, updatedAt: 20, settledAt: 20 },
    });

    expect(applyPiSubagentLineageTransition(completed, completed)).toMatchObject({
      kind: "unchanged",
    });
    expect(
      applyPiSubagentLineageTransition(
        completed,
        manifest({ timestamps: { createdAt: 10, updatedAt: 30 } }),
      ),
    ).toMatchObject({ kind: "rejected", manifest: { status: "completed" } });
    expect(
      applyPiSubagentLineageTransition(
        completed,
        manifest({
          status: "failed",
          timestamps: { createdAt: 10, updatedAt: 30, settledAt: 30 },
        }),
      ),
    ).toMatchObject({ kind: "rejected", manifest: { status: "completed" } });
  });

  it("rejects stale progress and identity changes", () => {
    const current = manifest({ timestamps: { createdAt: 10, updatedAt: 20 } });
    expect(
      applyPiSubagentLineageTransition(
        current,
        manifest({ timestamps: { createdAt: 10, updatedAt: 19 } }),
      ),
    ).toMatchObject({ kind: "rejected" });
    expect(
      applyPiSubagentLineageTransition(
        current,
        manifest({
          childSessionId: "different-child",
          timestamps: { createdAt: 10, updatedAt: 21 },
        }),
      ),
    ).toMatchObject({ kind: "rejected", reason: "lineage identity is immutable" });
  });
});
