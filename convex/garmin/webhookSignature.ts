/**
 * Garmin Push webhook authenticity check.
 *
 * Garmin Push webhooks do not arrive with an HMAC header in the partner
 * docs available to us. We therefore require an app-owned shared secret in
 * the registered webhook URL, e.g. `/garmin/webhook/activities/<secret>`.
 * Legacy query and replay-header credentials remain supported.
 *
 * For temporary dev-deployment testing before Garmin Portal URLs are
 * updated, GARMIN_ALLOW_UNAUTHENTICATED_WEBHOOKS=true bypasses this check
 * only when GARMIN_WEBHOOK_SECRET is unset.
 */

import { GARMIN_PUSH_EVENT_TYPES, type GarminPushEventType } from "./webhookDispatch";

export type SignatureCheckResult = { valid: true } | { valid: false; reason: string };
const EMPTY_BODY_REASON = "Empty Garmin webhook body";
const UNCONFIGURED_SECRET_REASON = "Garmin webhook secret is not configured";

export function garminWebhookFailureStatus(reason: string): 400 | 401 | 500 {
  if (reason === EMPTY_BODY_REASON) return 400;
  if (reason === UNCONFIGURED_SECRET_REASON) return 500;
  return 401;
}

function getConfiguredSecret(): string | null {
  const trimmed = process.env.GARMIN_WEBHOOK_SECRET?.trim();
  return trimmed && trimmed !== "" ? trimmed : null;
}

function allowsUnauthenticatedDevWebhooks(): boolean {
  return process.env.GARMIN_ALLOW_UNAUTHENTICATED_WEBHOOKS === "true";
}

function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const maxLength = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;

  for (let i = 0; i < maxLength; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }

  return diff === 0;
}

export function parseGarminWebhookPath(
  req: Request,
): { eventType: GarminPushEventType; secret: string } | null {
  const pathSegments = new URL(req.url).pathname.split("/");
  if (
    pathSegments.length !== 5 ||
    pathSegments[1] !== "garmin" ||
    pathSegments[2] !== "webhook" ||
    pathSegments[4] === ""
  ) {
    return null;
  }
  const eventType = GARMIN_PUSH_EVENT_TYPES.find((candidate) => candidate === pathSegments[3]);
  if (!eventType) return null;

  try {
    return { eventType, secret: decodeURIComponent(pathSegments[4]) };
  } catch {
    return null;
  }
}

export async function verifyGarminWebhookSignature(
  req: Request,
  rawBody: string,
): Promise<SignatureCheckResult> {
  if (rawBody.length === 0) {
    return { valid: false, reason: EMPTY_BODY_REASON };
  }
  const configuredSecret = getConfiguredSecret();
  if (!configuredSecret) {
    if (allowsUnauthenticatedDevWebhooks()) {
      return { valid: true };
    }
    return { valid: false, reason: UNCONFIGURED_SECRET_REASON };
  }

  const url = new URL(req.url);
  const pathSecret = parseGarminWebhookPath(req)?.secret ?? null;
  const providedSecret =
    pathSecret ?? url.searchParams.get("secret") ?? req.headers.get("x-roni-garmin-webhook-secret");
  if (!providedSecret || !constantTimeEqual(providedSecret, configuredSecret)) {
    return { valid: false, reason: "Invalid Garmin webhook secret" };
  }

  return { valid: true };
}
