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

    expect(screen.getByRole("switch", { name: "Ignore budget" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByLabelText("Budget limit per OpenAI attempt (USD)")).toHaveValue(0.42);
    expect(screen.getByText(/OpenAI is currently selected/i)).toBeVisible();
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

    fireEvent.click(screen.getByRole("switch", { name: "Ignore budget" }));

    await waitFor(() => {
      expect(mockIgnoreBudgetChange).toHaveBeenCalledWith(true);
    });
    expect(toast.success).toHaveBeenCalledWith("Budget guard disabled");
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

    const input = screen.getByLabelText("Budget limit per Anthropic Claude attempt (USD)");
    expect(input).toBeEnabled();
    expect(screen.getByText(/saved but not enforced/i)).toBeVisible();

    fireEvent.change(input, { target: { value: "0.25" } });
    fireEvent.click(screen.getByRole("button", { name: "Save limit" }));

    await waitFor(() => {
      expect(mockBudgetLimitSave).toHaveBeenCalledWith(0.25);
    });
    expect(toast.success).toHaveBeenCalledWith("Budget limit saved");
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

    const input = screen.getByLabelText("Budget limit per OpenRouter attempt (USD)");
    fireEvent.change(input, { target: { value: "0.009" } });
    const form = screen.getByRole("button", { name: "Save limit" }).closest("form");
    if (!form) throw new Error("Expected budget limit form");
    fireEvent.submit(form);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Budget limit must be between $0.01 and $100.00",
    );
    expect(mockBudgetLimitSave).not.toHaveBeenCalled();
  });
});
