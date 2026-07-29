import type { ModelMessage } from "ai";

const SEARCH_PROVENANCE = Symbol("searchProvenance");

type SearchTaggedMessage = ModelMessage & {
  [SEARCH_PROVENANCE]?: true;
};

export function hasSearchProvenance(message: ModelMessage): boolean {
  return (message as SearchTaggedMessage)[SEARCH_PROVENANCE] === true;
}

export function withSearchProvenance(message: ModelMessage): ModelMessage {
  const taggedMessage = { ...message } as SearchTaggedMessage;
  taggedMessage[SEARCH_PROVENANCE] = true;
  return taggedMessage;
}

export function withoutSearchProvenance(message: ModelMessage): ModelMessage {
  if (!hasSearchProvenance(message)) return message;
  const cleanMessage = { ...message } as SearchTaggedMessage;
  delete cleanMessage[SEARCH_PROVENANCE];
  return cleanMessage;
}
