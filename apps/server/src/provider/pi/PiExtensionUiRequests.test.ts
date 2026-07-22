import { ApprovalRequestId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  piCancelledExtensionUiResponse,
  piConfirmationResponse,
  piExtensionUiRequestId,
  piUserInputResponse,
  projectPiExtensionUiDialog,
} from "./PiExtensionUiRequests.ts";

describe("PiExtensionUiRequests", () => {
  it("uses the native Pi id as the stable canonical request id", () => {
    expect(piExtensionUiRequestId("native-ui-1")).toBe(ApprovalRequestId.make("native-ui-1"));
  });

  it("maps confirm to an approval and preserves Pi confirmation semantics", () => {
    const projection = projectPiExtensionUiDialog({
      type: "extension_ui_request",
      id: "confirm-1",
      method: "confirm",
      title: "Delete files?",
      message: "This can't be undone.",
      timeout: 5_000,
    });
    expect(projection.kind).toBe("approval");
    if (projection.kind !== "approval") return;
    expect(projection.payload).toMatchObject({
      requestType: "unknown",
      detail: "Delete files?: This can't be undone.",
    });
    expect(piConfirmationResponse(projection.pending, "accept")).toEqual({
      type: "extension_ui_response",
      id: "confirm-1",
      confirmed: true,
    });
    expect(piConfirmationResponse(projection.pending, "decline")).toEqual({
      type: "extension_ui_response",
      id: "confirm-1",
      confirmed: false,
    });
    expect(piConfirmationResponse(projection.pending, "cancel")).toEqual({
      type: "extension_ui_response",
      id: "confirm-1",
      cancelled: true,
    });
  });

  it.each([
    {
      method: "select" as const,
      request: {
        type: "extension_ui_request" as const,
        id: "select-1",
        method: "select" as const,
        title: "Choose",
        options: ["Allow", "Block"],
      },
      expectedOptions: ["Allow", "Block"],
    },
    {
      method: "input" as const,
      request: {
        type: "extension_ui_request" as const,
        id: "input-1",
        method: "input" as const,
        title: "Enter value",
        placeholder: "value",
      },
      expectedOptions: [],
    },
    {
      method: "editor" as const,
      request: {
        type: "extension_ui_request" as const,
        id: "editor-1",
        method: "editor" as const,
        title: "Edit value",
        prefill: "before",
      },
      expectedOptions: [],
    },
  ])("maps $method to one single-answer user-input question", ({ request, expectedOptions }) => {
    const projection = projectPiExtensionUiDialog(request);
    expect(projection.kind).toBe("user-input");
    if (projection.kind !== "user-input") return;
    const question = projection.payload.questions[0]!;
    expect(question.id).toBe(`${request.id}:value`);
    expect(question.options.map((option) => option.label)).toEqual(expectedOptions);
    expect(
      piUserInputResponse(projection.pending, { [question.id]: expectedOptions[0] ?? "text" }),
    ).toEqual({
      type: "extension_ui_response",
      id: request.id,
      value: expectedOptions[0] ?? "text",
    });
    expect(piCancelledExtensionUiResponse(projection.pending)).toEqual({
      type: "extension_ui_response",
      id: request.id,
      cancelled: true,
    });
  });

  it("rejects absent and ambiguous user-input answers", () => {
    const projection = projectPiExtensionUiDialog({
      type: "extension_ui_request",
      id: "select-2",
      method: "select",
      title: "Choose",
      options: ["One", "Two"],
    });
    if (projection.kind !== "user-input") throw new Error("expected user-input projection");
    expect(piUserInputResponse(projection.pending, {})).toBeUndefined();
    expect(
      piUserInputResponse(projection.pending, {
        [projection.pending.questionId]: ["One", "Two"],
      }),
    ).toBeUndefined();
  });
});
