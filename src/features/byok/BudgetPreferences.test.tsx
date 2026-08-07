import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { BudgetPreferences } from "./BudgetPreferences";

const mockIgnoreBudgetChange = vi.fn();
const mockBudgetLimitSave = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

describe("BudgetPreferences", () => {
  beforeEach(() => {
    mockIgnoreBudgetChange.mockReset();
    mockBudgetLimitSave.mockReset();
    vi.mocked(toast.error).mockReset();
    vi.mocked(toast.success).mockReset();
  });

  it("shows a semantic toggle and the selected provider limit", () => {
    render(
      <BudgetPreferences
        provider="openai"
        ignoreBudget={false}
        budgetLimitUsd={0.42}
        onIgnoreBudgetChange={mockIgnoreBudgetChange}
        onBudgetLimitSave={mockBudgetLimitSave}
      />,
    );

    expect(screen.getByRole("switch", { name: "Ignore budget for all providers" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByLabelText("Per-attempt budget threshold for OpenAI (USD)")).toHaveValue(
      0.42,
    );
    expect(screen.getByLabelText("Per-attempt budget threshold for OpenAI (USD)")).toHaveAttribute(
      "max",
      "200",
    );
    expect(screen.getByText(/OpenAI is currently selected/i)).toBeVisible();
    expect(screen.getByText(/checked after each completed model step/i)).toBeVisible();
    expect(
      screen.getByText(/one step can take the estimated cost past the threshold/i),
    ).toBeVisible();
    expect(
      screen.getByText(/retry or fallback starts a new model attempt with a fresh threshold/i),
    ).toBeVisible();
    expect(screen.queryByText(/up to this limit/i)).not.toBeInTheDocument();
  });

  it("saves the ignore preference immediately", async () => {
    mockIgnoreBudgetChange.mockResolvedValueOnce(undefined);
    render(
      <BudgetPreferences
        provider="gemini"
        ignoreBudget={false}
        budgetLimitUsd={0.1}
        onIgnoreBudgetChange={mockIgnoreBudgetChange}
        onBudgetLimitSave={mockBudgetLimitSave}
      />,
    );

    fireEvent.click(screen.getByRole("switch", { name: "Ignore budget for all providers" }));

    await waitFor(() => {
      expect(mockIgnoreBudgetChange).toHaveBeenCalledWith(true);
    });
    expect(toast.success).toHaveBeenCalledWith("Budget guard disabled for all providers");
  });

  it("keeps the provider limit editable and saves it while the guard is ignored", async () => {
    mockBudgetLimitSave.mockResolvedValueOnce(undefined);
    render(
      <BudgetPreferences
        provider="claude"
        ignoreBudget
        budgetLimitUsd={0.1}
        onIgnoreBudgetChange={mockIgnoreBudgetChange}
        onBudgetLimitSave={mockBudgetLimitSave}
      />,
    );

    const input = screen.getByLabelText("Per-attempt budget threshold for Anthropic Claude (USD)");
    expect(input).toBeEnabled();
    expect(screen.getByText(/no provider thresholds are enforced/i)).toBeVisible();

    fireEvent.change(input, { target: { value: "0.25" } });
    fireEvent.click(screen.getByRole("button", { name: "Save threshold" }));

    await waitFor(() => {
      expect(mockBudgetLimitSave).toHaveBeenCalledWith(0.25);
    });
    expect(toast.success).toHaveBeenCalledWith("Budget threshold saved");
  });

  it("rejects a provider limit below one cent", () => {
    render(
      <BudgetPreferences
        provider="openrouter"
        ignoreBudget={false}
        budgetLimitUsd={0.1}
        onIgnoreBudgetChange={mockIgnoreBudgetChange}
        onBudgetLimitSave={mockBudgetLimitSave}
      />,
    );

    const input = screen.getByLabelText("Per-attempt budget threshold for OpenRouter (USD)");
    fireEvent.change(input, { target: { value: "0.009" } });
    const form = screen.getByRole("button", { name: "Save threshold" }).closest("form");
    if (!form) throw new Error("Expected budget threshold form");
    fireEvent.submit(form);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Budget threshold must be between $0.01 and $200.00",
    );
    expect(mockBudgetLimitSave).not.toHaveBeenCalled();
  });
});
