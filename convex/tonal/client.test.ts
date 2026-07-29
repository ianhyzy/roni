import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRecentWorkoutActivities, fetchWorkoutActivitiesPage, TonalApiError } from "./client";

const TOKEN = "token";
const TONAL_USER_ID = "tonal-user";

interface MockPage {
  items: number[];
  pgTotal?: string;
}

function jsonResponse(items: unknown, pgTotal?: string): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (pgTotal !== undefined) headers.set("pg-total", pgTotal);
  return new Response(JSON.stringify(items), { status: 200, headers });
}

function requestOffset(init?: RequestInit): number {
  return Number(new Headers(init?.headers).get("pg-offset"));
}

function stubPages(pages: ReadonlyMap<number, MockPage>) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const offset = requestOffset(init);
    const page = pages.get(offset);
    if (!page) throw new Error(`Unexpected offset ${offset}`);
    return jsonResponse(page.items, page.pgTotal);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestedOffsets(fetchMock: ReturnType<typeof vi.fn>): number[] {
  return fetchMock.mock.calls.map(([, init]) => requestOffset(init as RequestInit | undefined));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("fetchWorkoutActivitiesPage", () => {
  it("uses a valid nonnegative integer pg-total as the absolute boundary", async () => {
    const fetchMock = stubPages(new Map([[200, { items: [200, 201], pgTotal: "500" }]]));

    const result = await fetchWorkoutActivitiesPage<number>(TOKEN, TONAL_USER_ID, 200, 2);

    expect(result).toEqual({ items: [200, 201], pgTotal: 500 });
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.tonal.com/v6/users/${TONAL_USER_ID}/workout-activities`,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${TOKEN}`,
          "pg-offset": "200",
          "pg-limit": "2",
        }),
      }),
    );
  });

  it("keeps a missing-header fallback absolute at a nonzero offset", async () => {
    stubPages(new Map([[200, { items: [200, 201] }]]));

    const result = await fetchWorkoutActivitiesPage<number>(TOKEN, TONAL_USER_ID, 200, 2);

    expect(result.pgTotal).toBe(203);
  });

  it.each(["not-a-number", "202.5", "201", "-1"])(
    "continues past malformed or inconsistent pg-total %s",
    async (pgTotal) => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      stubPages(new Map([[200, { items: [200, 201], pgTotal }]]));

      const result = await fetchWorkoutActivitiesPage<number>(TOKEN, TONAL_USER_ID, 200, 2);

      expect(result.pgTotal).toBe(203);
      expect(warnSpy).toHaveBeenCalledOnce();
    },
  );

  it("continues after an inconsistent short page and stops on the following empty page", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubPages(
      new Map([
        [200, { items: [200], pgTotal: "500" }],
        [201, { items: [], pgTotal: "500" }],
      ]),
    );

    const shortPage = await fetchWorkoutActivitiesPage<number>(TOKEN, TONAL_USER_ID, 200, 2);
    const emptyPage = await fetchWorkoutActivitiesPage<number>(TOKEN, TONAL_USER_ID, 201, 2);

    expect(shortPage.pgTotal).toBe(202);
    expect(emptyPage.pgTotal).toBe(201);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("throws TonalApiError for 401 responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 })),
    );

    const error: unknown = await fetchWorkoutActivitiesPage(TOKEN, TONAL_USER_ID, 0, 2).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(TonalApiError);
    expect(error).toMatchObject({
      status: 401,
      body: "Unauthorized",
    });
  });

  it("throws TonalApiError for other non-OK responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Unavailable", { status: 503 })));

    const error: unknown = await fetchWorkoutActivitiesPage(TOKEN, TONAL_USER_ID, 0, 2).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(TonalApiError);
    expect(error).toMatchObject({
      status: 503,
      body: "Unavailable",
    });
  });

  it("propagates malformed JSON failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("{broken", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(fetchWorkoutActivitiesPage(TOKEN, TONAL_USER_ID, 0, 2)).rejects.toThrow(
      SyntaxError,
    );
  });

  it("rejects a valid JSON body that is not an activity array", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ items: [] })));

    await expect(fetchWorkoutActivitiesPage(TOKEN, TONAL_USER_ID, 0, 2)).rejects.toThrow(
      "Tonal workout activities response must be an array",
    );
  });

  it("propagates fetch timeouts unchanged", async () => {
    const timeout = new DOMException("Timed out", "TimeoutError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeout));

    await expect(fetchWorkoutActivitiesPage(TOKEN, TONAL_USER_ID, 0, 2)).rejects.toBe(timeout);
  });
});

describe("fetchRecentWorkoutActivities", () => {
  it("uses an authoritative total to jump to the newest page", async () => {
    const fetchMock = stubPages(
      new Map([
        [0, { items: [0, 1], pgTotal: "6" }],
        [4, { items: [4, 5], pgTotal: "6" }],
      ]),
    );

    const result = await fetchRecentWorkoutActivities<number>(TOKEN, TONAL_USER_ID, 2);

    expect(result).toEqual([5, 4]);
    expect(requestedOffsets(fetchMock)).toEqual([0, 4]);
  });

  it.each([undefined, "5", "bad"])(
    "rescans sequentially when the jumped page total is %s",
    async (pgTotal) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const fetchMock = stubPages(
        new Map([
          [0, { items: [0, 1], pgTotal: "6" }],
          [2, { items: [2, 3] }],
          [4, { items: [4, 5], pgTotal }],
          [6, { items: [] }],
        ]),
      );

      const result = await fetchRecentWorkoutActivities<number>(TOKEN, TONAL_USER_ID, 2);

      expect(result).toEqual([5, 4]);
      expect(requestedOffsets(fetchMock)).toEqual([0, 4, 2, 4, 6]);
    },
  );

  it("rescans sequentially when the jumped page is short", async () => {
    const fetchMock = stubPages(
      new Map([
        [0, { items: [0, 1], pgTotal: "6" }],
        [2, { items: [2, 3] }],
        [4, { items: [4], pgTotal: "6" }],
        [5, { items: [5], pgTotal: "6" }],
      ]),
    );

    const result = await fetchRecentWorkoutActivities<number>(TOKEN, TONAL_USER_ID, 2);

    expect(result).toEqual([5, 4]);
    expect(requestedOffsets(fetchMock)).toEqual([0, 4, 2, 4, 5]);
  });

  it("walks exact-multiple pages to an empty page when pg-total is missing", async () => {
    const fetchMock = stubPages(
      new Map([
        [0, { items: [0, 1] }],
        [2, { items: [2, 3] }],
        [4, { items: [] }],
      ]),
    );

    const result = await fetchRecentWorkoutActivities<number>(TOKEN, TONAL_USER_ID, 2);

    expect(result).toEqual([3, 2]);
    expect(requestedOffsets(fetchMock)).toEqual([0, 2, 4]);
  });

  it.each(["bad", "1"])(
    "does not jump or stop on malformed or inconsistent total %s",
    async (pgTotal) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const fetchMock = stubPages(
        new Map([
          [0, { items: [0, 1], pgTotal }],
          [2, { items: [2, 3] }],
          [4, { items: [] }],
        ]),
      );

      const result = await fetchRecentWorkoutActivities<number>(TOKEN, TONAL_USER_ID, 2);

      expect(result).toEqual([3, 2]);
      expect(requestedOffsets(fetchMock)).toEqual([0, 2, 4]);
    },
  );

  it("advances by actual page length and returns at most count newest-first", async () => {
    const fetchMock = stubPages(
      new Map([
        [0, { items: [0, 1] }],
        [2, { items: [2] }],
        [3, { items: [] }],
      ]),
    );

    const result = await fetchRecentWorkoutActivities<number>(TOKEN, TONAL_USER_ID, 2);

    expect(result).toEqual([2, 1]);
    expect(requestedOffsets(fetchMock)).toEqual([0, 2, 3]);
  });
});
