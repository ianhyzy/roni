const SENSITIVE_OAUTH_QUERY_PARAM =
  /([?&#])((?:code|state|ticket|oauth(?:_|%5f)(?:token|verifier)|(?:access|id|refresh)(?:_|%5f)token))=([^&#\s"']*)/giu;

function redactOAuthQueryParams(value: string): string {
  return value.replace(
    SENSITIVE_OAUTH_QUERY_PARAM,
    (_match, separator: string, key: string) => `${separator}${key}=[REDACTED]`,
  );
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactOAuthQueryParams(value);
  if (Array.isArray(value)) {
    const redacted = value.map(redactValue);
    return redacted.some((entry, index) => entry !== value[index]) ? redacted : value;
  }
  if (value === null || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  let redacted: Record<string, unknown> | undefined;
  for (const [key, entry] of Object.entries(record)) {
    const nextEntry = redactValue(entry);
    if (nextEntry === entry) continue;
    redacted ??= { ...record };
    redacted[key] = nextEntry;
  }
  return redacted ?? value;
}

export function redactOAuthSecrets<T>(value: T): T {
  return redactValue(value) as T;
}
