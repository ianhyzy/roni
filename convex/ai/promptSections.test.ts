import { describe, expect, it } from "vitest";
import { ALL_SECTIONS, buildInstructions, REFERENCED_TOOLS, SECTION_NAMES } from "./promptSections";
import { coachAgentConfig } from "./coach";

const prompt = buildInstructions();

describe("section completeness", () => {
  it("buildInstructions includes all section headers", () => {
    for (const name of SECTION_NAMES) {
      expect(prompt).toContain(`${name}:`);
    }
  });

  it("buildInstructions produces non-empty output", () => {
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("no duplicate section headers", () => {
    for (const name of SECTION_NAMES) {
      const pattern = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`, "gm");
      const matches = prompt.match(pattern);
      expect(matches, `"${name}" appears more than once`).toHaveLength(1);
    }
  });

  it("sections are in expected order", () => {
    let lastIndex = -1;
    for (const name of SECTION_NAMES) {
      const index = prompt.indexOf(`${name}:`);
      expect(index, `"${name}" not found or out of order`).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }
  });
});

describe("tool name consistency", () => {
  const registeredTools = Object.keys(coachAgentConfig.tools);

  it("all tool names in prompt match registered tools", () => {
    for (const toolName of REFERENCED_TOOLS) {
      expect(
        registeredTools,
        `prompt references "${toolName}" but it is not a registered tool`,
      ).toContain(toolName);
    }
  });

  it("all registered tools are mentioned in the prompt", () => {
    for (const toolName of registeredTools) {
      expect(prompt, `registered tool "${toolName}" is never mentioned in the prompt`).toContain(
        toolName,
      );
    }
  });
});

describe("schema consistency", () => {
  it("weekPlanPresentation instructs AI not to output JSON", () => {
    const section = prompt.match(/WEEKLY PLAN PRESENTATION:([\s\S]*?)(?=\n[A-Z][A-Z ]+:|$)/);
    expect(section, "WEEKLY PLAN PRESENTATION section not found").toBeTruthy();
    expect(section![1]).toContain("Do NOT output JSON");
    expect(section![1]).not.toContain("```week-plan");
  });

  it("forbids claiming an action succeeded without a successful tool result", () => {
    expect(prompt).toContain("NEVER report an action as done unless the tool that performs it");
    expect(prompt).toContain(
      'An "execution-denied" result means that specific tool call did not run',
    );
    expect(prompt).toContain("If a side-effecting tool has no result, its outcome is unconfirmed");
    expect(prompt).not.toContain("whose result you cannot see did not run");
  });

  it("pairs the push success example with an actual approve_week_plan result", () => {
    const section = prompt.match(/EXAMPLES:([\s\S]*?)$/);
    expect(section, "EXAMPLES section not found").toBeTruthy();
    // The old few-shot jumped straight from "Looks good, send it" to "Done —
    // all 3 workouts are on your Tonal", teaching the model to treat the user's
    // approval phrasing as proof the push happened.
    expect(section![1]).toContain("[call approve_week_plan");
    expect(section![1]).toContain("Push denied (tool did not run)");
    expect(section![1]).toContain("Push result missing (outcome unconfirmed)");
    expect(section![1]).not.toContain("execution-denied, or you get no result");

    const missingResultExample = section![1].match(
      /Push result missing \(outcome unconfirmed\):([\s\S]*?)(?=\n\n|$)/,
    );
    expect(missingResultExample).toBeTruthy();
    expect(missingResultExample![1]).toContain("couldn't confirm");
    expect(missingResultExample![1]).toContain("check your Tonal");
    expect(missingResultExample![1]).not.toContain("Nothing has changed");
    expect(missingResultExample![1]).not.toContain("still a draft");
  });

  it("routes permanent movement bans to exclude_exercises rather than report_injury", () => {
    expect(prompt).toContain("exclude_exercises");
    expect(prompt).toContain("Permanent exercise bans");
    expect(prompt).toContain("exact current catalog entries");
    expect(prompt).toContain("do not automatically cover future catalog additions");
  });

  it("frames volume-strength analysis as advisory rather than causal MRV", () => {
    expect(prompt).toContain("analyze_volume_strength");
    expect(prompt).toContain("observational");
    expect(prompt).toContain("not causal MRV");
    expect(prompt).toContain("hard cap");
  });
});

describe("structural integrity", () => {
  it("prompt does not exceed 300 lines", () => {
    const lineCount = prompt.split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(300);
  });

  it("each section function returns a non-empty string", () => {
    for (const fn of ALL_SECTIONS) {
      const result = fn();
      expect(result.length, `${fn.name} returned empty string`).toBeGreaterThan(0);
    }
  });

  it("each section starts with its header", () => {
    // Skip role() which has no SECTION_NAMES header
    const sectionsWithHeaders = ALL_SECTIONS.slice(1);
    for (let i = 0; i < sectionsWithHeaders.length; i++) {
      const text = sectionsWithHeaders[i]();
      const expectedHeader = SECTION_NAMES[i];
      expect(
        text.startsWith(`${expectedHeader}:`),
        `${sectionsWithHeaders[i].name}() does not start with "${expectedHeader}:"`,
      ).toBe(true);
    }
  });

  it("no section contains another section's header", () => {
    const sectionsWithHeaders = ALL_SECTIONS.slice(1);
    for (let i = 0; i < sectionsWithHeaders.length; i++) {
      const text = sectionsWithHeaders[i]();
      const ownHeader = SECTION_NAMES[i];
      for (const otherHeader of SECTION_NAMES) {
        if (otherHeader === ownHeader) continue;
        const pattern = new RegExp(`^${otherHeader.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`, "m");
        expect(
          pattern.test(text),
          `${sectionsWithHeaders[i].name}() contains header "${otherHeader}:"`,
        ).toBe(false);
      }
    }
  });
});
