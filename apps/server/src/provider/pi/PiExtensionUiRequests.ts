import {
  ApprovalRequestId,
  RuntimeRequestId,
  type ProviderApprovalDecision,
  type ProviderUserInputAnswers,
  type UserInputQuestion,
} from "@t3tools/contracts";

import type { PiRpcExtensionUIRequest, PiRpcExtensionUIResponse } from "./PiRpcProtocol.ts";

type PiDialogRequest = Extract<
  PiRpcExtensionUIRequest,
  { readonly method: "select" | "confirm" | "input" | "editor" }
>;

export type PiPendingExtensionUiRequest =
  | {
      readonly kind: "approval";
      readonly requestId: ApprovalRequestId;
      readonly nativeRequestId: string;
      readonly request: Extract<PiDialogRequest, { readonly method: "confirm" }>;
    }
  | {
      readonly kind: "user-input";
      readonly requestId: ApprovalRequestId;
      readonly nativeRequestId: string;
      readonly questionId: string;
      readonly request: Exclude<PiDialogRequest, { readonly method: "confirm" }>;
    };

export type PiExtensionUiProjection =
  | {
      readonly kind: "approval";
      readonly pending: Extract<PiPendingExtensionUiRequest, { readonly kind: "approval" }>;
      readonly payload: {
        readonly requestType: "unknown";
        readonly detail: string;
        readonly args: unknown;
      };
    }
  | {
      readonly kind: "user-input";
      readonly pending: Extract<PiPendingExtensionUiRequest, { readonly kind: "user-input" }>;
      readonly payload: { readonly questions: ReadonlyArray<UserInputQuestion> };
    };

function nonEmpty(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export function piExtensionUiRequestId(nativeRequestId: string): ApprovalRequestId {
  return ApprovalRequestId.make(nativeRequestId);
}

export function piExtensionUiRuntimeRequestId(nativeRequestId: string): RuntimeRequestId {
  return RuntimeRequestId.make(piExtensionUiRequestId(nativeRequestId));
}

export function projectPiExtensionUiDialog(request: PiDialogRequest): PiExtensionUiProjection {
  const requestId = piExtensionUiRequestId(request.id);
  if (request.method === "confirm") {
    const title = nonEmpty(request.title, "Pi extension confirmation");
    const message = nonEmpty(request.message, "Confirm this Pi extension request.");
    return {
      kind: "approval",
      pending: { kind: "approval", requestId, nativeRequestId: request.id, request },
      payload: {
        requestType: "unknown",
        detail: `${title}: ${message}`,
        args: {
          method: request.method,
          title: request.title,
          message: request.message,
          ...(request.timeout === undefined ? {} : { timeout: request.timeout }),
        },
      },
    };
  }

  const methodLabel = request.method === "select" ? "Choose an option" : "Enter a value";
  const title = nonEmpty(request.title, `Pi extension: ${methodLabel}`);
  const questionId = `${request.id}:value`;
  const question: UserInputQuestion = {
    id: questionId,
    header: title,
    question: title,
    options:
      request.method === "select"
        ? request.options.map((option) => ({
            label: nonEmpty(option, "Unnamed option"),
            description: `Select ${nonEmpty(option, "this option")}`,
          }))
        : [],
    multiSelect: false,
  };
  return {
    kind: "user-input",
    pending: {
      kind: "user-input",
      requestId,
      nativeRequestId: request.id,
      questionId,
      request,
    },
    payload: { questions: [question] },
  };
}

export function piConfirmationResponse(
  pending: Extract<PiPendingExtensionUiRequest, { readonly kind: "approval" }>,
  decision: ProviderApprovalDecision,
): PiRpcExtensionUIResponse {
  if (decision === "cancel") {
    return { type: "extension_ui_response", id: pending.nativeRequestId, cancelled: true };
  }
  return {
    type: "extension_ui_response",
    id: pending.nativeRequestId,
    confirmed: decision === "accept" || decision === "acceptForSession",
  };
}

export function piUserInputResponse(
  pending: Extract<PiPendingExtensionUiRequest, { readonly kind: "user-input" }>,
  answers: ProviderUserInputAnswers,
): PiRpcExtensionUIResponse | undefined {
  const answer = answers[pending.questionId];
  if (typeof answer === "string") {
    return { type: "extension_ui_response", id: pending.nativeRequestId, value: answer };
  }
  if (Array.isArray(answer)) {
    const strings = answer.filter((value): value is string => typeof value === "string");
    if (strings.length === 1) {
      return { type: "extension_ui_response", id: pending.nativeRequestId, value: strings[0]! };
    }
  }
  return undefined;
}

export function piCancelledExtensionUiResponse(
  pending: PiPendingExtensionUiRequest,
): PiRpcExtensionUIResponse {
  return { type: "extension_ui_response", id: pending.nativeRequestId, cancelled: true };
}
