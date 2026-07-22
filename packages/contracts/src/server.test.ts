import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { resolveServerProviderCapabilities, ServerProvider } from "./server.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);

describe("ServerProvider", () => {
  it("defaults capability arrays when decoding provider snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.slashCommands).toEqual([]);
    expect(parsed.skills).toEqual([]);
    expect(resolveServerProviderCapabilities(parsed.capabilities)).toEqual({
      allowedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
      resumeReplay: true,
      imageInput: true,
      inSessionModelSwitching: true,
      thinkingLevelSwitching: true,
      steering: true,
      followUpQueue: true,
      extensionUiRequests: true,
      approvals: true,
      userInput: true,
      subagentLineage: false,
      workflowArtifacts: false,
      rollback: true,
      fork: true,
    });
    expect(parsed.versionAdvisory).toBeUndefined();
    expect(parsed.updateState).toBeUndefined();
  });

  it("decodes an explicit fail-closed provider capability descriptor", () => {
    const parsed = decodeServerProvider({
      instanceId: "pi",
      driver: "pi",
      enabled: true,
      installed: true,
      version: "0.80.10",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-07-22T00:00:00.000Z",
      models: [],
      capabilities: {
        allowedRuntimeModes: ["full-access"],
        resumeReplay: true,
        imageInput: true,
        inSessionModelSwitching: true,
        thinkingLevelSwitching: true,
        steering: true,
        followUpQueue: true,
        extensionUiRequests: false,
        approvals: false,
        userInput: false,
        subagentLineage: false,
        workflowArtifacts: false,
        rollback: false,
        fork: false,
      },
    });

    const capabilities = resolveServerProviderCapabilities(parsed.capabilities);
    expect(capabilities.allowedRuntimeModes).toEqual(["full-access"]);
    expect(capabilities.approvals).toBe(false);
    expect(capabilities.rollback).toBe(false);
  });

  it("defaults fields omitted by an older capability descriptor", () => {
    const parsed = decodeServerProvider({
      instanceId: "pi",
      driver: "pi",
      enabled: true,
      installed: true,
      version: "0.80.10",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-07-22T00:00:00.000Z",
      models: [],
      capabilities: {
        allowedRuntimeModes: ["full-access"],
        rollback: false,
      },
    });

    const capabilities = resolveServerProviderCapabilities(parsed.capabilities);
    expect(capabilities.allowedRuntimeModes).toEqual(["full-access"]);
    expect(capabilities.rollback).toBe(false);
    expect(capabilities.resumeReplay).toBe(true);
    expect(capabilities.workflowArtifacts).toBe(false);
  });

  it("defaults one-click update support when decoding older advisory snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
      versionAdvisory: {
        status: "behind_latest",
        currentVersion: "1.0.0",
        latestVersion: "1.0.1",
        updateCommand: "npm install -g @openai/codex@latest",
        checkedAt: "2026-04-10T00:00:00.000Z",
        message: "Update available.",
      },
    });

    expect(parsed.versionAdvisory?.canUpdate).toBe(false);
  });

  it("decodes continuation group metadata", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex_personal",
      driver: "codex",
      continuation: { groupKey: "codex:home:/Users/julius/.codex" },
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.continuation?.groupKey).toBe("codex:home:/Users/julius/.codex");
  });
});
