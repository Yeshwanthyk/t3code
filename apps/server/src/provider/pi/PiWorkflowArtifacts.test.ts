// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { PiWorkflowArtifactReader, type PiWorkflowStatus } from "./PiWorkflowArtifacts.ts";

const tempDirectories: Array<string> = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

function makeAgentDir(): string {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-workflows-"));
  tempDirectories.push(directory);
  NodeFS.mkdirSync(NodePath.join(directory, "workflows"), { recursive: true });
  return directory;
}

function workflowValue(input: {
  readonly runId: string;
  readonly status?: PiWorkflowStatus;
  readonly name?: string;
  readonly startedAt?: number;
}) {
  const status = input.status ?? "running";
  const startedAt = input.startedAt ?? 10;
  return {
    runId: input.runId,
    sessionId: "parent-session-a",
    name: input.name ?? "Evidence workflow",
    description: "Provider-owned artifact fixture",
    background: true,
    status,
    startedAt,
    ...(status === "running" ? {} : { finishedAt: startedAt + 10 }),
    phases: [{ title: "Inspect", detail: "Read authoritative artifacts" }],
    currentPhase: "Inspect",
    agents: [
      {
        index: 1,
        label: "artifact-reader",
        phase: "Inspect",
        state: status === "running" ? "running" : status === "completed" ? "done" : "error",
        model: "provider/model",
        thinkingLevel: "high",
        startedAt,
        ...(status === "running" ? {} : { finishedAt: startedAt + 10 }),
        preview: "reading",
        usage: { input: 3, output: 5, outputComplete: true },
        transcript: [],
      },
    ],
    result: "[stored in result.json]",
    resultArtifact: "result.json",
    transcriptArtifact: "transcripts.json",
    ...(status === "failed" ? { error: "workflow failed" } : {}),
    ...(status === "aborted" ? { error: "workflow aborted" } : {}),
  };
}

function writeRun(
  agentDir: string,
  input: {
    readonly runId: string;
    readonly status?: PiWorkflowStatus;
    readonly name?: string;
    readonly startedAt?: number;
  },
): string {
  const runDir = NodePath.join(agentDir, "workflows", input.runId);
  NodeFS.mkdirSync(runDir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(runDir, "transcripts.json"),
    JSON.stringify({
      "1": [
        { role: "user", text: "inspect artifacts", timestamp: 10 },
        {
          role: "toolResult",
          text: "complete",
          name: "read",
          toolCallId: "call-a",
          isError: false,
        },
      ],
    }),
  );
  NodeFS.writeFileSync(NodePath.join(runDir, "result.json"), JSON.stringify({ answer: 42 }));
  NodeFS.writeFileSync(
    NodePath.join(runDir, "script.js"),
    "export default await agent('inspect')\n",
  );
  NodeFS.writeFileSync(
    NodePath.join(runDir, "workflow.json"),
    JSON.stringify(workflowValue(input)),
  );
  return runDir;
}

function replaceWorkflow(runDir: string, value: unknown): void {
  const temporary = NodePath.join(runDir, "workflow.json.tmp");
  NodeFS.writeFileSync(temporary, JSON.stringify(value));
  NodeFS.renameSync(temporary, NodePath.join(runDir, "workflow.json"));
}

describe("PiWorkflowArtifactReader", () => {
  it("reads authoritative sidecars as inert data scoped to one provider instance and Pi root", () => {
    const agentDir = makeAgentDir();
    writeRun(agentDir, { runId: "wf_0123456789ab" });
    const reader = new PiWorkflowArtifactReader({
      providerInstanceId: "pi-instance-a",
      piAgentDir: agentDir,
    });

    const result = reader.read("wf_0123456789ab");
    expect(result).toMatchObject({
      kind: "updated",
      snapshot: {
        version: 1,
        providerInstanceId: "pi-instance-a",
        piAgentDir: agentDir,
        status: "running",
        result: { answer: 42 },
        scriptText: "export default await agent('inspect')\n",
        agents: [{ queuedAt: 10, transcript: [{ role: "user" }, { role: "toolResult" }] }],
      },
    });
    expect(reader.read("wf_0123456789ab")).toMatchObject({ kind: "unchanged" });
  });

  it("recognizes all four producer statuses and reconstructs them after restart", () => {
    const agentDir = makeAgentDir();
    const statuses: ReadonlyArray<PiWorkflowStatus> = ["running", "completed", "failed", "aborted"];
    statuses.forEach((status, index) =>
      writeRun(agentDir, {
        runId: `wf_00000000000${index}`,
        status,
        startedAt: 10 + index,
      }),
    );

    const restarted = new PiWorkflowArtifactReader({
      providerInstanceId: "pi-instance-a",
      piAgentDir: agentDir,
    });
    expect(
      restarted
        .reconstruct()
        .map((snapshot) => snapshot.status)
        .sort(),
    ).toEqual([...statuses].sort());
    expect(restarted.read("wf_000000000003")).toMatchObject({
      snapshot: { status: "aborted", error: "workflow aborted" },
    });
  });

  it("keeps different Pi homes and provider instances distinct", () => {
    const firstRoot = makeAgentDir();
    const secondRoot = makeAgentDir();
    writeRun(firstRoot, { runId: "wf_aaaaaaaaaaaa", name: "first root" });
    writeRun(secondRoot, { runId: "wf_aaaaaaaaaaaa", name: "second root" });

    const first = new PiWorkflowArtifactReader({
      providerInstanceId: "pi-instance-a",
      piAgentDir: firstRoot,
    }).read("wf_aaaaaaaaaaaa");
    const second = new PiWorkflowArtifactReader({
      providerInstanceId: "pi-instance-b",
      piAgentDir: secondRoot,
    }).read("wf_aaaaaaaaaaaa");

    expect(first).toMatchObject({
      snapshot: { providerInstanceId: "pi-instance-a", piAgentDir: firstRoot, name: "first root" },
    });
    expect(second).toMatchObject({
      snapshot: {
        providerInstanceId: "pi-instance-b",
        piAgentDir: secondRoot,
        name: "second root",
      },
    });
  });

  it("retains the last valid snapshot through partial and oversized writes", () => {
    const agentDir = makeAgentDir();
    const runDir = writeRun(agentDir, { runId: "wf_bbbbbbbbbbbb" });
    const reader = new PiWorkflowArtifactReader({
      providerInstanceId: "pi-instance-a",
      piAgentDir: agentDir,
      maxTranscriptsBytes: 512,
    });
    expect(reader.read("wf_bbbbbbbbbbbb")).toMatchObject({ kind: "updated" });

    NodeFS.writeFileSync(NodePath.join(runDir, "workflow.json"), '{"runId":');
    expect(reader.read("wf_bbbbbbbbbbbb")).toMatchObject({
      kind: "stale",
      snapshot: { status: "running" },
      issue: { code: "invalid_json" },
    });

    replaceWorkflow(runDir, workflowValue({ runId: "wf_bbbbbbbbbbbb" }));
    NodeFS.writeFileSync(NodePath.join(runDir, "transcripts.json"), "x".repeat(513));
    expect(reader.read("wf_bbbbbbbbbbbb")).toMatchObject({
      kind: "stale",
      issue: { code: "too_large" },
    });
  });

  it("accepts an atomic terminal replacement, then prevents terminal regression", () => {
    const agentDir = makeAgentDir();
    const runId = "wf_cccccccccccc";
    const runDir = writeRun(agentDir, { runId });
    const reader = new PiWorkflowArtifactReader({
      providerInstanceId: "pi-instance-a",
      piAgentDir: agentDir,
    });
    expect(reader.read(runId)).toMatchObject({ snapshot: { status: "running" } });

    replaceWorkflow(runDir, workflowValue({ runId, status: "completed" }));
    expect(reader.read(runId)).toMatchObject({
      kind: "updated",
      snapshot: { status: "completed" },
    });

    replaceWorkflow(runDir, workflowValue({ runId, status: "completed" }));
    expect(reader.read(runId)).toMatchObject({
      kind: "unchanged",
      snapshot: { status: "completed" },
    });

    replaceWorkflow(runDir, workflowValue({ runId, status: "running" }));
    expect(reader.read(runId)).toMatchObject({
      kind: "stale",
      snapshot: { status: "completed" },
      issue: { code: "terminal_regression" },
    });
  });

  it("rejects traversal, mismatched ids, unsafe sidecars, and symlinked run directories", () => {
    const agentDir = makeAgentDir();
    const runDir = writeRun(agentDir, { runId: "wf_dddddddddddd" });
    const reader = new PiWorkflowArtifactReader({
      providerInstanceId: "pi-instance-a",
      piAgentDir: agentDir,
    });

    expect(reader.read("../outside")).toMatchObject({
      kind: "unavailable",
      issue: { code: "invalid_run_id" },
    });
    replaceWorkflow(runDir, {
      ...workflowValue({ runId: "wf_other" }),
      runId: "wf_other",
    });
    expect(reader.read("wf_dddddddddddd")).toMatchObject({
      kind: "unavailable",
      issue: { code: "invalid_artifact" },
    });

    const outside = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-workflow-outside-"));
    tempDirectories.push(outside);
    NodeFS.symlinkSync(outside, NodePath.join(agentDir, "workflows", "wf_eeeeeeeeeeee"));
    expect(reader.read("wf_eeeeeeeeeeee")).toMatchObject({
      kind: "unavailable",
      issue: { code: "unsafe_path" },
    });
  });
});
