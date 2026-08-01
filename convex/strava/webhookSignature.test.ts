import { describe, expect, it } from "vitest";
import { verifyStravaWebhookSignature } from "./webhookSignature";

const NOW = Date.parse("2026-07-30T12:00:00.000Z");
const SECRET = "webhook-signing-secret-123";

async function signatureHeader(body: string, timestamp: number): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${body}`)),
  );
  const hex = Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `t=${timestamp},v1=${hex}`;
}

describe("Strava webhook signatures", () => {
  it("accepts an exact fresh timestamp and raw body signature", async () => {
    const body = '{"object_type":"activity"}';
    const timestamp = Math.floor(NOW / 1_000);

    await expect(
      verifyStravaWebhookSignature(await signatureHeader(body, timestamp), body, SECRET, NOW),
    ).resolves.toBe(true);
  });

  it("rejects missing, malformed, stale, duplicated, and tampered signatures", async () => {
    const body = '{"object_type":"activity"}';
    const timestamp = Math.floor(NOW / 1_000);
    const valid = await signatureHeader(body, timestamp);
    const stale = await signatureHeader(body, timestamp - 301);

    for (const header of [null, "t=1,v1=bad", `${valid},v1=${"0".repeat(64)}`, stale]) {
      await expect(verifyStravaWebhookSignature(header, body, SECRET, NOW)).resolves.toBe(false);
    }
    await expect(verifyStravaWebhookSignature(valid, `${body} `, SECRET, NOW)).resolves.toBe(false);
  });
});
