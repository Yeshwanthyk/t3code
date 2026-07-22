import { describe, expect, it } from "vite-plus/test";

import { allowedRuntimeModesForProvider, compatibleRuntimeMode } from "./providerCapabilities";

describe("provider runtime capabilities", () => {
  it("preserves legacy runtime modes when capabilities are absent", () => {
    expect(allowedRuntimeModesForProvider(undefined)).toEqual([
      "approval-required",
      "auto-accept-edits",
      "full-access",
    ]);
  });

  it("exposes only full access for Pi and selects it as the compatible fallback", () => {
    const allowed = allowedRuntimeModesForProvider({
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

    expect(allowed).toEqual(["full-access"]);
    expect(compatibleRuntimeMode("auto-accept-edits", allowed)).toBe("full-access");
  });
});
