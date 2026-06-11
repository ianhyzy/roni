import { describe, expect, it } from "vitest";
import {
  buildListSearchText,
  buildMovementSearchFields,
  matchesNameSearch,
  matchesNameSearchStrict,
  scoreNameMatch,
} from "./movementSearch";

const rdl = {
  name: "RDL",
  shortName: "RDL",
  descriptionHow:
    "Stand with feet hip-width apart. Hinge at the hips, pushing them back while keeping a slight bend in the knees. Lower the handles along your legs until you feel a stretch in your hamstrings, then drive your hips forward to return to standing. This is also known as a Romanian Deadlift.",
  descriptionWhy: "Strengthens the posterior chain — hamstrings, glutes, and lower back.",
};

const benchPress = { name: "Bench Press", shortName: "Bench Press" };
const bicepCurl = { name: "Bicep Curl", shortName: "Bicep Curl" };
const latPulldown = { name: "Lat Pulldown", shortName: "Lat Pulldown" };
const pushup = { name: "Pushup", shortName: "Pushup" };
const gobletSquat = { name: "Goblet Squat", shortName: "Goblet Squat" };
const tricepExtension = { name: "Triceps Extension", shortName: "Triceps Ext" };
const chestFlye = { name: "Chest Flye", shortName: "Chest Flye" };

describe("matchesNameSearch", () => {
  it("matches exact name", () => {
    expect(matchesNameSearch(benchPress, "Bench Press")).toBe(true);
  });

  it("matches case-insensitive substring", () => {
    expect(matchesNameSearch(benchPress, "bench")).toBe(true);
  });

  it("matches shortName", () => {
    expect(matchesNameSearch(tricepExtension, "Ext")).toBe(true);
  });

  it("matches common name via description (RDL → Romanian Deadlift)", () => {
    expect(matchesNameSearch(rdl, "Romanian Deadlift")).toBe(true);
  });

  it("matches via descriptionWhy", () => {
    expect(matchesNameSearch(rdl, "posterior chain")).toBe(true);
  });

  it("matches word-level: any word from query in description", () => {
    expect(matchesNameSearch(rdl, "hamstring exercise")).toBe(true);
  });

  it("matches word-level: any word from query in name", () => {
    expect(matchesNameSearch(gobletSquat, "barbell squat")).toBe(true);
  });

  it("matches tricep/triceps alias", () => {
    expect(matchesNameSearch(tricepExtension, "tricep extension")).toBe(true);
  });

  it("matches fly/flye alias", () => {
    expect(matchesNameSearch(chestFlye, "chest fly")).toBe(true);
  });

  it("matches pullup variations", () => {
    expect(matchesNameSearch(pushup, "push-up")).toBe(true);
    expect(matchesNameSearch(pushup, "push up")).toBe(true);
  });

  it("matches lat pulldown variations", () => {
    expect(matchesNameSearch(latPulldown, "lat pull-down")).toBe(true);
  });

  it("returns true for empty query", () => {
    expect(matchesNameSearch(rdl, "")).toBe(true);
  });

  it("does not match unrelated exercises", () => {
    expect(matchesNameSearch(bicepCurl, "squat")).toBe(false);
    expect(matchesNameSearch(rdl, "bench press")).toBe(false);
  });

  it("skips short words (< 3 chars) for word-level matching", () => {
    expect(matchesNameSearch(benchPress, "an")).toBe(false);
  });

  it("works without description fields", () => {
    expect(matchesNameSearch({ name: "RDL", shortName: "RDL" }, "RDL")).toBe(true);
  });

  it("matches abbreviation aliases (RDL ↔ Romanian Deadlift)", () => {
    expect(matchesNameSearch({ name: "RDL", shortName: "RDL" }, "Romanian Deadlift")).toBe(true);
    expect(
      matchesNameSearch({ name: "Romanian Deadlift", shortName: "Romanian Deadlift" }, "RDL"),
    ).toBe(true);
  });

  it("matches OHP ↔ Overhead Press alias", () => {
    expect(matchesNameSearch({ name: "OHP", shortName: "OHP" }, "overhead press")).toBe(true);
  });

  // Gym name → Tonal name aliases
  it("matches face pull → standing face pull", () => {
    const standingFacePull = { name: "Standing Face Pull", shortName: "Standing Face Pull" };
    expect(matchesNameSearch(standingFacePull, "face pull")).toBe(true);
  });

  it("matches rear delt fly → reverse fly via multi-word alias", () => {
    const reverseFly = { name: "Reverse Fly", shortName: "Reverse Fly" };
    expect(matchesNameSearch(reverseFly, "rear delt fly")).toBe(true);
  });

  it("matches french press → overhead triceps extension", () => {
    const ohe = { name: "Overhead Triceps Extension", shortName: "Overhead Triceps Ext" };
    expect(matchesNameSearch(ohe, "french press")).toBe(true);
  });

  it("matches lying tricep extension → skull crusher", () => {
    const skullCrusher = { name: "Skull Crusher", shortName: "Skull Crusher" };
    expect(matchesNameSearch(skullCrusher, "lying tricep extension")).toBe(true);
  });

  it("matches plank → pillar bridge via alias", () => {
    const pillarBridge = { name: "Pillar Bridge", shortName: "Pillar Bridge" };
    expect(matchesNameSearch(pillarBridge, "plank")).toBe(true);
  });

  it("matches shoulder press → standing overhead press", () => {
    const sop = { name: "Standing Overhead Press", shortName: "Standing Overhead Press" };
    expect(matchesNameSearch(sop, "shoulder press")).toBe(true);
  });

  it("matches lat raise → lateral raise", () => {
    const lateralRaise = { name: "Lateral Raise", shortName: "Lateral Raise" };
    expect(matchesNameSearch(lateralRaise, "lat raise")).toBe(true);
  });

  it("matches hamstring curl → prone bench hamstring curl", () => {
    const pbhc = { name: "Prone Bench Hamstring Curl", shortName: "Prone Bench Hamstring Curl" };
    expect(matchesNameSearch(pbhc, "hamstring curl")).toBe(true);
  });
});

describe("matchesNameSearchStrict", () => {
  const cat = {
    name: "Single Leg Chop",
    shortName: "SL Chop",
    descriptionHow: "Brace glutes and bridge core to maintain stability",
    descriptionWhy: "Trains anti-rotation",
  };

  it("does NOT match on description-only hits", () => {
    expect(matchesNameSearchStrict(cat, "Glute Bridge")).toBe(false);
  });

  it("matches on direct name substring", () => {
    expect(matchesNameSearchStrict({ ...cat, name: "Resisted Glute Bridge" }, "Glute Bridge")).toBe(
      true,
    );
  });

  it("matches on alias group within name only", () => {
    const sldlMovement = {
      name: "Single Leg Romanian Deadlift",
      shortName: "SL RDL",
      descriptionHow: "",
      descriptionWhy: "",
    };
    expect(matchesNameSearchStrict(sldlMovement, "RDL")).toBe(true);
  });

  it("returns false when query has no name overlap even if descriptions hint at it", () => {
    expect(
      matchesNameSearchStrict(
        {
          name: "Standing Chop",
          shortName: "Std Chop",
          descriptionHow: "Hip thrust pattern",
          descriptionWhy: "",
        },
        "Hip Thrust",
      ),
    ).toBe(false);
  });
});

describe("scoreNameMatch", () => {
  const m = (name: string, shortName = name) => ({ name, shortName });

  it("returns 0 for an empty query", () => {
    expect(scoreNameMatch(m("Bench Press"), "")).toBe(0);
  });

  it("scores an exact full-name match higher than a contained-phrase match", () => {
    const exact = scoreNameMatch(m("Bench Press"), "Bench Press");
    const contained = scoreNameMatch(m("Alternating Bench Press"), "Bench Press");
    expect(exact).toBeGreaterThan(contained);
  });

  it("scores a contained phrase higher than a single-word overlap", () => {
    const contained = scoreNameMatch(m("Alternating Bench Press"), "Bench Press");
    const oneWord = scoreNameMatch(m("Triceps Bench Dip"), "Bench Press");
    expect(contained).toBeGreaterThan(oneWord);
  });

  it("ranks the exact movement first even when long incidental names also match", () => {
    // Regression: the real "Bench Press" must outrank "Triceps Bench Dip".
    const exact = scoreNameMatch(m("Bench Press"), "Bench Press");
    const incidental = scoreNameMatch(m("Triceps Bench Dip"), "Bench Press");
    expect(exact).toBeGreaterThan(incidental);
  });

  it("scores all query words present (any order) above a single-word overlap", () => {
    const allWords = scoreNameMatch(m("Barbell Front Squat"), "Barbell Squat");
    const oneWord = scoreNameMatch(m("Iso Split Squat Chop"), "Barbell Squat");
    expect(allWords).toBeGreaterThan(oneWord);
  });

  it("breaks single-word-overlap ties toward the shorter, more canonical name", () => {
    const shortName = scoreNameMatch(m("Goblet Squat"), "Barbell Squat");
    const longName = scoreNameMatch(m("Iso Split Squat Chop"), "Barbell Squat");
    expect(shortName).toBeGreaterThan(longName);
  });

  it("returns 0 when only the description would match (name-only ranking)", () => {
    const chop = {
      name: "Single Leg Chop",
      shortName: "SL Chop",
      descriptionHow: "Brace glutes and bridge core to maintain stability",
      descriptionWhy: "",
    };
    expect(scoreNameMatch(chop, "Glute Bridge")).toBe(0);
  });

  it("returns 0 for an unrelated movement", () => {
    expect(scoreNameMatch(m("Lateral Raise"), "Bench Press")).toBe(0);
  });

  it("scores an alias-resolved name above zero (RDL → Romanian Deadlift)", () => {
    expect(scoreNameMatch(m("Romanian Deadlift"), "RDL")).toBeGreaterThan(0);
  });

  it("scores an exact shortName match strongly", () => {
    const exactShort = scoreNameMatch(
      { name: "Triceps Extension", shortName: "Triceps Ext" },
      "Triceps Ext",
    );
    const incidental = scoreNameMatch(m("Triceps Bench Dip"), "Triceps Ext");
    expect(exactShort).toBeGreaterThan(incidental);
  });
});

describe("buildMovementSearchFields", () => {
  it("builds denormalized search text with aliases", () => {
    const fields = buildMovementSearchFields({
      name: "Romanian Deadlift",
      shortName: "Romanian Deadlift",
      muscleGroups: ["Hamstrings", "Glutes"],
      trainingTypes: ["Strength", "Warm-up"],
    });

    expect(fields.nameSearchText).toContain("romanian deadlift");
    expect(fields.nameSearchText).toContain("rdl");
    expect(fields.muscleGroupsSearchText).toBe("hamstrings glutes");
    expect(fields.trainingTypesSearchText).toBe("strength warm up");
  });

  it("normalizes list values for search indexes", () => {
    expect(buildListSearchText(["Warm-up", "Full Body"])).toBe("warm up full body");
  });
});
