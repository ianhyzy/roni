const TONAL_API_BASE = "https://api.tonal.com";

export class TonalApiError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(`Tonal API ${status}: ${body}`);
    this.name = "TonalApiError";
  }
}

export async function tonalFetch<T = unknown>(
  token: string,
  path: string,
  options?: { method?: string; body?: unknown },
): Promise<T> {
  const res = await fetch(`${TONAL_API_BASE}${path}`, {
    method: options?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: options?.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options?.method === "POST" ? 30_000 : 15_000),
  });

  if (res.status === 401) {
    const body = await res.text().catch(() => "Token expired or invalid");
    throw new TonalApiError(401, body);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    throw new TonalApiError(res.status, body);
  }

  return res.json() as Promise<T>;
}

const PG_PAGE_SIZE = 200;

interface WorkoutActivitiesPage<T> {
  items: T[];
  pgTotal: number;
  hasAuthoritativeTotal: boolean;
}

function resolvePgTotal(
  rawPgTotal: string | null,
  offset: number,
  itemCount: number,
  limit: number,
): Pick<WorkoutActivitiesPage<never>, "pgTotal" | "hasAuthoritativeTotal"> {
  const parsed = rawPgTotal === null || rawPgTotal.trim() === "" ? Number.NaN : Number(rawPgTotal);
  const observedEnd = offset + itemCount;
  const hasValidHeader = Number.isSafeInteger(parsed) && parsed >= 0;
  const pageShapeMatchesTotal =
    itemCount >= limit || parsed === observedEnd || (itemCount === 0 && parsed <= offset);
  const hasAuthoritativeTotal = hasValidHeader && parsed >= observedEnd && pageShapeMatchesTotal;

  if (!hasAuthoritativeTotal && rawPgTotal !== null) {
    console.warn(
      `[fetchWorkoutActivitiesPage] Malformed or inconsistent pg-total header: "${rawPgTotal}"`,
    );
  }

  return {
    pgTotal: hasAuthoritativeTotal ? parsed : observedEnd + (itemCount > 0 ? 1 : 0),
    hasAuthoritativeTotal,
  };
}

async function requestWorkoutActivitiesPage<T>(
  token: string,
  tonalUserId: string,
  offset: number,
  limit: number,
): Promise<WorkoutActivitiesPage<T>> {
  const res = await fetch(`${TONAL_API_BASE}/v6/users/${tonalUserId}/workout-activities`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "pg-offset": String(offset),
      "pg-limit": String(limit),
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (res.status === 401) {
    throw new TonalApiError(401, await res.text().catch(() => "Unauthorized"));
  }
  if (!res.ok) {
    throw new TonalApiError(res.status, await res.text().catch(() => res.statusText));
  }

  const payload: unknown = await res.json();
  if (!Array.isArray(payload)) {
    throw new Error("Tonal workout activities response must be an array");
  }
  const items = payload as T[];
  return { items, ...resolvePgTotal(res.headers.get("pg-total"), offset, items.length, limit) };
}

/**
 * Fetch a single page of /workout-activities using pg-offset/pg-limit headers.
 * Returns { items, pgTotal } so callers can decide whether to continue.
 */
export async function fetchWorkoutActivitiesPage<T>(
  token: string,
  tonalUserId: string,
  offset: number,
  limit: number = PG_PAGE_SIZE,
): Promise<{ items: T[]; pgTotal: number }> {
  const { items, pgTotal } = await requestWorkoutActivitiesPage<T>(
    token,
    tonalUserId,
    offset,
    limit,
  );
  return { items, pgTotal };
}

async function collectRecentTail<T>(
  token: string,
  tonalUserId: string,
  count: number,
  initialItems: T[],
  initialOffset: number,
  initialTotal?: number,
): Promise<T[]> {
  let tail = initialItems.slice(-count);
  let offset = initialOffset;
  let continuationBoundary = initialTotal;

  while (continuationBoundary === undefined || offset < continuationBoundary) {
    const page = await requestWorkoutActivitiesPage<T>(token, tonalUserId, offset, count);
    if (page.items.length === 0) break;

    tail = [...tail, ...page.items].slice(-count);
    offset += page.items.length;
    if (page.hasAuthoritativeTotal) {
      continuationBoundary = Math.max(continuationBoundary ?? 0, page.pgTotal);
    }
  }

  return tail.reverse();
}

/**
 * Fetch the most recent workout activities (newest first) by reading from the
 * end of the paginated list. Returns up to `count` items, newest first.
 * Used by incremental sync - typically 1 API call instead of 5+.
 */
export async function fetchRecentWorkoutActivities<T>(
  token: string,
  tonalUserId: string,
  count: number = PG_PAGE_SIZE,
): Promise<T[]> {
  if (count <= 0) return [];

  const firstPage = await requestWorkoutActivitiesPage<T>(token, tonalUserId, 0, count);

  if (!firstPage.hasAuthoritativeTotal) {
    return collectRecentTail(token, tonalUserId, count, firstPage.items, firstPage.items.length);
  }

  if (firstPage.items.length >= firstPage.pgTotal) {
    return firstPage.items.slice(-count).reverse();
  }

  const startOffset = Math.max(0, firstPage.pgTotal - count);
  if (startOffset <= firstPage.items.length) {
    return collectRecentTail(
      token,
      tonalUserId,
      count,
      firstPage.items,
      firstPage.items.length,
      firstPage.pgTotal,
    );
  }

  const lastPage = await requestWorkoutActivitiesPage<T>(token, tonalUserId, startOffset, count);
  const hasTrustedLastPage =
    lastPage.hasAuthoritativeTotal &&
    lastPage.pgTotal === firstPage.pgTotal &&
    startOffset + lastPage.items.length >= firstPage.pgTotal;
  if (!hasTrustedLastPage) {
    return collectRecentTail(token, tonalUserId, count, firstPage.items, firstPage.items.length);
  }

  return lastPage.items.slice(-count).reverse();
}
