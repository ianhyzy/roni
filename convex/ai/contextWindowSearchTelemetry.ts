import type { ModelMessage } from "ai";
import {
  buildFullPromptContextWindow,
  type FullPromptContextWindowArgs,
  mergeConsecutiveSameRole,
  stripImagesFromOlderMessages,
  stripOrphanedToolCalls,
} from "./contextWindow";
import {
  hasSearchProvenance,
  withoutSearchProvenance,
  withSearchProvenance,
} from "./searchProvenance";

export interface SearchTelemetryContextWindowArgs extends FullPromptContextWindowArgs {
  searchMessages: ModelMessage[];
}

export interface SearchTelemetryContextWindow {
  messages: ModelMessage[];
  searchUsed: boolean;
}

export function buildSearchTelemetryContextWindow({
  messages,
  searchMessages,
  promptBudgetTokens,
  reservedPromptTokens,
}: SearchTelemetryContextWindowArgs): SearchTelemetryContextWindow {
  const searchMessageSet = new WeakSet(searchMessages);
  const taggedMessages = messages.map((message) =>
    searchMessageSet.has(message) ? withSearchProvenance(message) : message,
  );
  const normalizedMessages = mergeConsecutiveSameRole(
    stripImagesFromOlderMessages(stripOrphanedToolCalls(taggedMessages)),
  );
  const windowedMessages = buildFullPromptContextWindow({
    messages: normalizedMessages,
    promptBudgetTokens,
    reservedPromptTokens,
  });

  return {
    messages: windowedMessages.map(withoutSearchProvenance),
    searchUsed: windowedMessages.some(hasSearchProvenance),
  };
}
