import type { ModelMessage } from "ai";

type AssistantMessage = Extract<ModelMessage, { role: "assistant" }>;
type AssistantParts = Exclude<AssistantMessage["content"], string>;
type ToolMessage = Extract<ModelMessage, { role: "tool" }>;

type ToolPartReference = {
  type: string;
  approvalId?: string;
  toolCallId?: string;
};

export function readToolPartReference(value: unknown): ToolPartReference | null {
  if (value === null || typeof value !== "object") return null;
  if (!("type" in value) || typeof value.type !== "string") return null;
  const approvalId =
    "approvalId" in value && typeof value.approvalId === "string" ? value.approvalId : undefined;
  const toolCallId =
    "toolCallId" in value && typeof value.toolCallId === "string" ? value.toolCallId : undefined;
  return {
    type: value.type,
    ...(approvalId ? { approvalId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
  };
}

export function withAssistantParts(
  message: AssistantMessage,
  content: AssistantParts,
): AssistantMessage {
  return { ...message, content };
}

export function withToolParts(message: ToolMessage, content: ToolMessage["content"]): ToolMessage {
  return { ...message, content };
}
