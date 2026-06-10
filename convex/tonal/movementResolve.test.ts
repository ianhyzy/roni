import { describe, expect, it } from "vitest";
import { type ResolvableMovement, resolveMovement } from "./movementResolve";
import { TONAL_REST_MOVEMENT_ID } from "./transforms";

const mv = (id: string, name: string, shortName = name): ResolvableMovement => ({
  id,
  name,
  shortName,
  descriptionHow: "",
  descriptionWhy: "",
});

const catalog: ResolvableMovement[] = [
  mv("id-alt-bench", "Alternating Bench Press"),
  mv("id-decline", "Standing Decline Chest Press"),
  mv("id-bench", "Bench Press"),
  mv("id-lateral", "Lateral Raise"),
];

describe("resolveMovement", () => {
  it("resolves a valid movementId via id when the name gives no exact match", () => {
    const out = resolveMovement({ movementId: "id-bench", name: "anything" }, catalog);

    expect(out).toEqual({ status: "resolved", movementId: "id-bench", via: "id" });
  });

  it("resolves the well-known Rest sentinel via id", () => {
    const out = resolveMovement({ movementId: TONAL_REST_MOVEMENT_ID }, catalog);

    expect(out).toEqual({ status: "resolved", movementId: TONAL_REST_MOVEMENT_ID, via: "id" });
  });

  it("substitutes a fabricated id using an exact name match", () => {
    const out = resolveMovement(
      { movementId: "fabricated-uuid-not-in-catalog", name: "Bench Press" },
      catalog,
    );

    expect(out).toEqual({ status: "resolved", movementId: "id-bench", via: "exact-name" });
  });

  it("prefers an exact full-name match over a valid-but-stale supplied id", () => {
    // The coach copies a real id from another exercise but gives the correct new
    // name; the name must win so the right movement is pushed.
    const out = resolveMovement({ movementId: "id-bench", name: "Lateral Raise" }, catalog);

    expect(out).toEqual({ status: "resolved", movementId: "id-lateral", via: "exact-name" });
  });

  it("prefers an exact name match over fuzzy candidates", () => {
    const out = resolveMovement({ name: "Bench Press" }, catalog);

    expect(out).toEqual({ status: "resolved", movementId: "id-bench", via: "exact-name" });
  });

  it("prefers an exact full name over another movement's shortName alias", () => {
    const localCatalog = [
      mv("id-reverse-fly", "Reverse Fly"),
      mv("id-rear-delt", "Rear Delt Raise", "Reverse Fly"),
    ];

    const out = resolveMovement({ name: "Reverse Fly" }, localCatalog);

    expect(out).toEqual({ status: "resolved", movementId: "id-reverse-fly", via: "exact-name" });
  });

  it("does not auto-substitute a broad single-word fuzzy match", () => {
    // "Decline" overlaps only "Standing Decline Chest Press", but a lone fuzzy
    // match may be the wrong exercise, so surface it as a candidate instead.
    const out = resolveMovement({ name: "Decline" }, catalog);

    expect(out.status).toBe("ambiguous");
    if (out.status === "ambiguous") {
      expect(out.candidates).toEqual([
        { movementId: "id-decline", name: "Standing Decline Chest Press" },
      ]);
    }
  });

  it("returns ambiguous candidates when a name matches multiple movements", () => {
    const out = resolveMovement({ name: "Press" }, catalog);

    expect(out.status).toBe("ambiguous");
    if (out.status === "ambiguous") {
      const names = out.candidates.map((c) => c.name).sort();
      expect(names).toEqual([
        "Alternating Bench Press",
        "Bench Press",
        "Standing Decline Chest Press",
      ]);
    }
  });

  it("returns not-found when neither id nor name resolves", () => {
    const out = resolveMovement(
      { movementId: "fabricated-uuid", name: "Nonexistent Movement XYZ" },
      catalog,
    );

    expect(out).toEqual({
      status: "not-found",
      ref: { movementId: "fabricated-uuid", name: "Nonexistent Movement XYZ" },
    });
  });

  it("returns not-found when given neither a valid id nor a name", () => {
    const out = resolveMovement({ movementId: "fabricated-uuid" }, catalog);

    expect(out.status).toBe("not-found");
  });
});
