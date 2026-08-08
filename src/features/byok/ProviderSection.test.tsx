import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderSection } from "./ProviderSection";

const mockGetSettings = vi.fn();
const mockSaveKey = vi.fn();
const mockRemoveKey = vi.fn();
const mockSelectProvider = vi.fn();
const mockSetModelOverride = vi.fn();
const mockSetIgnoreBudget = vi.fn();
const mockSetSelectedProviderBudgetLimit = vi.fn();

let mockByokStatus:
  | {
      requiresBYOK: boolean;
      hasKey: boolean;
    }
  | undefined;

vi.mock("convex/react", () => ({
  useAction: (ref: string) => {
    if (ref === "byokProvider:getProviderSettings") return mockGetSettings;
    if (ref === "byok:saveProviderKey") return mockSaveKey;
    throw new Error(`Unexpected action ${ref}`);
  },
  useMutation: (ref: string) => {
    if (ref === "byok:removeProviderKey") return mockRemoveKey;
    if (ref === "byok:setSelectedProvider") return mockSelectProvider;
    if (ref === "byok:setModelOverride") return mockSetModelOverride;
    if (ref === "byokProvider:setIgnoreBudget") return mockSetIgnoreBudget;
    if (ref === "byokProvider:setSelectedProviderBudgetLimit") {
      return mockSetSelectedProviderBudgetLimit;
    }
    throw new Error(`Unexpected mutation ${ref}`);
  },
  useQuery: () => mockByokStatus,
}));

vi.mock("../../../convex/_generated/api", () => ({
  api: {
    byok: {
      getBYOKStatus: "byok:getBYOKStatus",
      removeProviderKey: "byok:removeProviderKey",
      saveProviderKey: "byok:saveProviderKey",
      setModelOverride: "byok:setModelOverride",
      setSelectedProvider: "byok:setSelectedProvider",
    },
    byokProvider: {
      getProviderSettings: "byokProvider:getProviderSettings",
      setIgnoreBudget: "byokProvider:setIgnoreBudget",
      setSelectedProviderBudgetLimit: "byokProvider:setSelectedProviderBudgetLimit",
    },
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

describe("ProviderSection", () => {
  beforeEach(() => {
    mockGetSettings.mockReset();
    mockSaveKey.mockReset();
    mockRemoveKey.mockReset();
    mockSelectProvider.mockReset();
    mockSetModelOverride.mockReset();
    mockSetIgnoreBudget.mockReset();
    mockSetSelectedProviderBudgetLimit.mockReset();
    mockByokStatus = {
      requiresBYOK: true,
      hasKey: true,
    };
  });

  it("does not show a false settings load error after removing the last key", async () => {
    mockGetSettings
      .mockResolvedValueOnce({
        selectedProvider: "gemini",
        modelOverride: null,
        budgetPreferences: {
          ignoreBudget: false,
          providerLimitsUsd: { gemini: 0.1, claude: 0.1, openai: 0.1, openrouter: 0.1 },
        },
        keys: {
          gemini: { hasKey: true, maskedLast4: "1234", addedAt: 1700000000000 },
          claude: { hasKey: false },
          openai: { hasKey: false },
          openrouter: { hasKey: false },
        },
      })
      .mockResolvedValueOnce(null);
    mockRemoveKey.mockResolvedValueOnce(undefined);

    render(<ProviderSection />);

    expect(await screen.findByText(/key ending in/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /remove key/i }));

    await waitFor(() => {
      expect(mockRemoveKey).toHaveBeenCalledWith({ provider: "gemini" });
      expect(mockGetSettings).toHaveBeenCalledTimes(2);
    });

    expect(
      screen.queryByText("Failed to load provider settings. Try again."),
    ).not.toBeInTheDocument();
  });

  it("saves and refreshes the ignore preference for the actual selected provider", async () => {
    const providerLimitsUsd = { gemini: 0.1, claude: 0.2, openai: 0.42, openrouter: 0.3 };
    const keys = {
      gemini: { hasKey: false },
      claude: { hasKey: false },
      openai: { hasKey: true, maskedLast4: "5678", addedAt: 1700000000000 },
      openrouter: { hasKey: false },
    };
    mockGetSettings
      .mockResolvedValueOnce({
        selectedProvider: "openai",
        modelOverride: null,
        budgetPreferences: { ignoreBudget: false, providerLimitsUsd },
        keys,
      })
      .mockResolvedValueOnce({
        selectedProvider: "openai",
        modelOverride: null,
        budgetPreferences: { ignoreBudget: true, providerLimitsUsd },
        keys,
      });
    mockSetIgnoreBudget.mockResolvedValueOnce(undefined);

    render(<ProviderSection />);

    expect(
      await screen.findByLabelText("Per-attempt budget threshold for OpenAI (USD)"),
    ).toHaveValue(0.42);
    fireEvent.click(screen.getByRole("switch", { name: "Ignore budget for all providers" }));

    await waitFor(() => {
      expect(mockSetIgnoreBudget).toHaveBeenCalledWith({ ignoreBudget: true });
      expect(mockGetSettings).toHaveBeenCalledTimes(2);
      expect(
        screen.getByRole("switch", { name: "Ignore budget for all providers" }),
      ).toHaveAttribute("aria-checked", "true");
    });
  });

  it("saves the selected provider limit and refreshes settings", async () => {
    const keys = {
      gemini: { hasKey: false },
      claude: { hasKey: true, maskedLast4: "9876", addedAt: 1700000000000 },
      openai: { hasKey: false },
      openrouter: { hasKey: false },
    };
    mockGetSettings
      .mockResolvedValueOnce({
        selectedProvider: "claude",
        modelOverride: null,
        budgetPreferences: {
          ignoreBudget: true,
          providerLimitsUsd: { gemini: 0.1, claude: 0.25, openai: 0.1, openrouter: 0.1 },
        },
        keys,
      })
      .mockResolvedValueOnce({
        selectedProvider: "claude",
        modelOverride: null,
        budgetPreferences: {
          ignoreBudget: true,
          providerLimitsUsd: { gemini: 0.1, claude: 0.55, openai: 0.1, openrouter: 0.1 },
        },
        keys,
      });
    mockSetSelectedProviderBudgetLimit.mockResolvedValueOnce(undefined);

    render(<ProviderSection />);

    const input = await screen.findByLabelText(
      "Per-attempt budget threshold for Anthropic Claude (USD)",
    );
    expect(input).toBeEnabled();
    fireEvent.change(input, { target: { value: "0.55" } });
    fireEvent.click(screen.getByRole("button", { name: "Save threshold" }));

    await waitFor(() => {
      expect(mockSetSelectedProviderBudgetLimit).toHaveBeenCalledWith({ budgetLimitUsd: 0.55 });
      expect(mockGetSettings).toHaveBeenCalledTimes(2);
      expect(
        screen.getByLabelText("Per-attempt budget threshold for Anthropic Claude (USD)"),
      ).toHaveValue(0.55);
    });
  });
});
