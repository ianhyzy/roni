const SIGNATURE_FRESHNESS_SECONDS = 5 * 60;
const HEX_SIGNATURE_PATTERN = /^[a-f0-9]{64}$/i;

export async function verifyStravaWebhookToken(
  received: string | null,
  expected: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const [receivedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(received ?? "")),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return (
    constantTimeBytesEqual(new Uint8Array(receivedHash), new Uint8Array(expectedHash)) &&
    received !== null
  );
}

function parseSignatureHeader(
  header: string | null,
): { timestamp: number; signature: string } | null {
  if (!header) return null;
  const values = new Map<string, string>();
  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator <= 0) return null;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (values.has(key)) return null;
    values.set(key, value);
  }
  const timestampRaw = values.get("t");
  const signature = values.get("v1");
  if (!timestampRaw || !signature || values.size !== 2 || !HEX_SIGNATURE_PATTERN.test(signature)) {
    return null;
  }
  const timestamp = Number(timestampRaw);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) return null;
  return { timestamp, signature: signature.toLowerCase() };
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function constantTimeBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export async function verifyStravaWebhookSignature(
  header: string | null,
  rawBody: string,
  signingSecret: string,
  now = Date.now(),
): Promise<boolean> {
  const parsed = parseSignatureHeader(header);
  if (
    !parsed ||
    Math.abs(Math.floor(now / 1_000) - parsed.timestamp) > SIGNATURE_FRESHNESS_SECONDS
  ) {
    return false;
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(`${parsed.timestamp}.${rawBody}`)),
  );
  return constantTimeBytesEqual(hexToBytes(parsed.signature), expected);
}
