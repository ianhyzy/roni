import { describe, expect, it } from "vitest";
import { getReadyApprovalToolNames, isApprovalStepReady } from "./chatApproval";

const requestMessage = {
  _id: "request-message",
  order: 4,
  message: {
    role: "assistant",
    content: [
      {
        type: "tool-approval-request",
        approvalId: "approval-1",
        toolCallId: "tool-call-1",
      },
      {
        type: "tool-approval-request",
        approvalId: "approval-2",
        toolCallId: "tool-call-2",
      },
      { type: "tool-call", toolCallId: "tool-call-1", toolName: "approve_week_plan" },
      { type: "tool-call", toolCallId: "tool-call-2", toolName: "delete_week_plan" },
    ],
  },
};

describe("isApprovalStepReady", () => {
  it("waits until every approval request in the step has a response", () => {
    const partialResponse = {
      _id: "response-message",
      order: 4,
      message: {
        role: "tool",
        content: [{ type: "tool-approval-response", approvalId: "approval-1" }],
      },
    };

    expect(isApprovalStepReady([partialResponse, requestMessage], "response-message")).toBe(false);
  });

  it("allows one continuation after all approval responses are merged", () => {
    const completeResponse = {
      _id: "response-message",
      order: 4,
      message: {
        role: "tool",
        content: [
          { type: "tool-approval-response", approvalId: "approval-1" },
          { type: "tool-approval-response", approvalId: "approval-2" },
        ],
      },
    };

    expect(isApprovalStepReady([completeResponse, requestMessage], "response-message")).toBe(true);
    expect(
      getReadyApprovalToolNames([completeResponse, requestMessage], "response-message"),
    ).toEqual(["approve_week_plan", "delete_week_plan"]);
  });

  it("does not expose tool names before the approval step is ready", () => {
    expect(getReadyApprovalToolNames([requestMessage], "missing-response")).toEqual([]);
  });

  it("does not merge approval groups that merely share an order", () => {
    const otherRequest = {
      _id: "other-request",
      order: 4,
      message: {
        role: "assistant",
        content: [{ type: "tool-approval-request", approvalId: "other-approval" }],
      },
    };
    const response = {
      _id: "response-message",
      order: 4,
      message: {
        role: "tool",
        content: [{ type: "tool-approval-response", approvalId: "approval-1" }],
      },
    };

    expect(isApprovalStepReady([response, otherRequest, requestMessage], "response-message")).toBe(
      false,
    );
  });
});
