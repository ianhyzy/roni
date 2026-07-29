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

export function isApprovalStepReady(
  messages: readonly ApprovalMessage[],
  responseMessageId: string,
): boolean {
  const response = messages.find((message) => message._id === responseMessageId);
  if (!response) return false;

  const respondedIds = new Set(getApprovalIds(response, "tool-approval-response"));
  if (respondedIds.size === 0) return false;

  const requestIds = messages
    .filter((message) => message.order === response.order && message.message?.role === "assistant")
    .map((message) => getApprovalIds(message, "tool-approval-request"))
    .find((ids) => ids.some((id) => respondedIds.has(id)));

  return !!requestIds?.length && requestIds.every((id) => respondedIds.has(id));
}
