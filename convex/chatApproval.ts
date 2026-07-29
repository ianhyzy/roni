interface ApprovalMessage {
  _id: string;
  order: number;
  message?: {
    role: string;
    content: unknown;
  };
}

function getApprovalIds(message: ApprovalMessage, partType: string): string[] {
  const content = message.message?.content;
  if (!Array.isArray(content)) return [];

  const ids: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object" || !("type" in part) || part.type !== partType) continue;
    if (!("approvalId" in part) || typeof part.approvalId !== "string") continue;
    ids.push(part.approvalId);
  }
  return ids;
}

function getReadyApprovalRequest(
  messages: readonly ApprovalMessage[],
  responseMessageId: string,
): ApprovalMessage | undefined {
  const response = messages.find((message) => message._id === responseMessageId);
  if (!response) return undefined;

  const respondedIds = new Set(getApprovalIds(response, "tool-approval-response"));
  if (respondedIds.size === 0) return undefined;

  const request = messages
    .filter((message) => message.order === response.order && message.message?.role === "assistant")
    .find((message) =>
      getApprovalIds(message, "tool-approval-request").some((id) => respondedIds.has(id)),
    );
  if (!request) return undefined;

  const requestIds = getApprovalIds(request, "tool-approval-request");
  return requestIds.length > 0 && requestIds.every((id) => respondedIds.has(id))
    ? request
    : undefined;
}

export function isApprovalStepReady(
  messages: readonly ApprovalMessage[],
  responseMessageId: string,
): boolean {
  return getReadyApprovalRequest(messages, responseMessageId) !== undefined;
}

export function getReadyApprovalToolNames(
  messages: readonly ApprovalMessage[],
  responseMessageId: string,
): string[] {
  const request = getReadyApprovalRequest(messages, responseMessageId);
  const content = request?.message?.content;
  if (!Array.isArray(content)) return [];

  const approvedToolCallIds = new Set(
    content.flatMap((part) => {
      if (!part || typeof part !== "object" || !("type" in part)) return [];
      if (part.type !== "tool-approval-request" || !("toolCallId" in part)) return [];
      return typeof part.toolCallId === "string" ? [part.toolCallId] : [];
    }),
  );
  return content.flatMap((part) => {
    if (!part || typeof part !== "object" || !("type" in part)) return [];
    if (part.type !== "tool-call" || !("toolCallId" in part) || !("toolName" in part)) return [];
    if (typeof part.toolCallId !== "string" || !approvedToolCallIds.has(part.toolCallId)) return [];
    return typeof part.toolName === "string" ? [part.toolName] : [];
  });
}
