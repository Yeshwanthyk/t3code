// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { PiWorkflowWatcher } from "./PiWorkflowWatcher.ts";

const tempDirectories: Array<string> = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

function makeAgentDir(): string {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-watcher-"));
  tempDirectories.push(directory);
  NodeFS.mkdirSync(NodePath.join(directory, "workflows"), { recursive: true });
  return directory;
}

function workflow(runId: string, status: "running" | "completed" | "failed" | "aborted") {
  return {
    runId,
    sessionId: "native-session-a",
    name: "Watcher fixture",
    background: true,
    status,
    startedAt: 10,
    ...(status === "running" ? {} : { finishedAt: 20 }),
    phases: [{ title: "Watch" }],
    currentPhase: "Watch",
    agents: [
      {
        index: 1,
        label: "watcher",
        state: status === "running" ? "running" : status === "completed" ? "done" : "error",
        queuedAt: 10,
        preview: "watching",
        usage: {},
        transcript: [],
      },
    ],
    transcriptArtifact: "transcripts.json",
  };
}

function writeRun(
  agentDir: string,
  runId: string,
  status: "running" | "completed" | "failed" | "aborted",
): string {
  const runDir = NodePath.join(agentDir, "workflows", runId);
  NodeFS.mkdirSync(runDir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(runDir, "transcripts.json"), "{}");
  NodeFS.writeFileSync(
    NodePath.join(runDir, "workflow.json"),
    JSON.stringify(workflow(runId, status)),
  );
  return runDir;
}

function replaceWorkflow(
  runDir: string,
  runId: string,
  status: "running" | "completed" | "failed" | "aborted",
): void {
  const temporary = NodePath.join(runDir, "workflow.json.tmp");
  NodeFS.writeFileSync(temporary, JSON.stringify(workflow(runId, status)));
  NodeFS.renameSync(temporary, NodePath.join(runDir, "workflow.json"));
}

describe("PiWorkflowWatcher", () => {
  it("maintains a stable-run-id read model and emits accepted watched transitions", async () => {
    const agentDir = makeAgentDir();
    const runId = "wf_0123456789ab";
    const runDir = writeRun(agentDir, runId, "running");
    let triggerWatch: (() => void) | undefined;
    let watchClosed = false;
    let pollStopped = false;
    const scans: Array<ReturnType<PiWorkflowWatcher["scan"]>> = [];
    const watcher = new PiWorkflowWatcher({
      providerInstanceId: "pi-instance-a",
      piAgentDir: agentDir,
      watchFactory: (_directory, onChange) => {
        triggerWatch = onChange;
        return { close: () => (watchClosed = true) };
      },
      pollFactory: () => () => (pollStopped = true),
    });

    watcher.start((result) => scans.push(result));
    expect(scans[0]).toMatchObject({
      changes: [{ runId, current: { status: "running" } }],
      issues: [],
    });
    expect(watcher.get(runId)).toMatchObject({ status: "running" });

    replaceWorkflow(runDir, runId, "completed");
    triggerWatch?.();
    await Promise.resolve();
    expect(scans.at(-1)).toMatchObject({
      changes: [{ runId, previous: { status: "running" }, current: { status: "completed" } }],
    });
    expect(watcher.list()).toMatchObject([{ runId, status: "completed" }]);

    watcher.stop();
    expect(watchClosed).toBe(true);
    expect(pollStopped).toBe(true);
  });

  it("retains terminal details and reports regressions without publishing a change", () => {
    const agentDir = makeAgentDir();
    const runId = "wf_aaaaaaaaaaaa";
    const runDir = writeRun(agentDir, runId, "aborted");
    const watcher = new PiWorkflowWatcher({
      providerInstanceId: "pi-instance-a",
      piAgentDir: agentDir,
    });
    expect(watcher.scan()).toMatchObject({ changes: [{ current: { status: "aborted" } }] });

    replaceWorkflow(runDir, runId, "running");
    expect(watcher.scan()).toMatchObject({
      changes: [],
      issues: [{ runId, code: "terminal_regression" }],
      snapshots: [{ runId, status: "aborted" }],
    });
    expect(watcher.scan()).toMatchObject({
      changes: [],
      issues: [],
      snapshots: [{ runId, status: "aborted" }],
    });
  });

  it("reconstructs terminal details as a fresh change after restart", () => {
    const agentDir = makeAgentDir();
    const runId = "wf_bbbbbbbbbbbb";
    writeRun(agentDir, runId, "failed");

    const restarted = new PiWorkflowWatcher({
      providerInstanceId: "pi-instance-a",
      piAgentDir: agentDir,
    });
    expect(restarted.scan()).toMatchObject({
      changes: [{ runId, current: { status: "failed" } }],
      snapshots: [{ runId, status: "failed" }],
    });
  });
});
