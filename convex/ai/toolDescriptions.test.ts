import { describe, expect, it } from "vitest";
import { z } from "zod";
import { coachAgentConfig } from "./coach";

const toolDefinitionSchema = z.object({
  description: z.string().optional(),
  inputExamples: z.array(z.unknown()).optional(),
});

type ToolDefinition = z.infer<typeof toolDefinitionSchema>;

const REQUIRED_EXAMPLE_TOOLS = [
  "program_week",
  "create_workout",
  "add_exercise",
  "set_goal",
] as const satisfies (keyof typeof coachAgentConfig.tools)[];

function asToolDefinition(tool: unknown): ToolDefinition {
  const parsed = toolDefinitionSchema.safeParse(tool);
  return parsed.success ? parsed.data : {};
}

describe("coach tool descriptions", () => {
  const tools = Object.entries(coachAgentConfig.tools).map(([name, tool]) => ({
    name,
    tool: asToolDefinition(tool),
  }));

  it("keeps routing guidance on every registered tool", () => {
    for (const { name, tool } of tools) {
      const description = tool.description?.trim() ?? "";

      expect(description, `${name} is missing a non-empty description`).not.toHaveLength(0);
      expect(description, `${name} should say when to use it`).toContain("Use");
      expect(description, `${name} should say when not to use it`).toMatch(/Do not|Never|Does not/);
      expect(description, `${name} should describe inputs and outputs`).toMatch(
        /Inputs?[\s\S]*returns?|returns?[\s\S]*Inputs?/i,
      );
    }
  });

  it("provides examples for complex tool inputs", () => {
    for (const toolName of REQUIRED_EXAMPLE_TOOLS) {
      const tool = asToolDefinition(coachAgentConfig.tools[toolName]);
      expect(tool.inputExamples, `${toolName} should define inputExamples`).toBeTruthy();
      expect(
        tool.inputExamples?.length,
        `${toolName} should include at least one example`,
      ).toBeGreaterThan(0);
    }
  });
});
