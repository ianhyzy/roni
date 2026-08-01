import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { NutritionTargetsForm } from "./NutritionTargetsForm";
import type { NutritionTargets } from "./nutritionForm";

const mockSetTargets = vi.fn();
const mockClearTargets = vi.fn();

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createTargets(overrides: Partial<NutritionTargets> = {}): NutritionTargets {
  return {
    source: "self_set",
    caloriesKcal: 2_400,
    proteinGrams: 180,
    carbsGrams: null,
    fatGrams: 75,
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

function renderForm(initialTargets: NutritionTargets | null = null) {
  return render(
    <NutritionTargetsForm
      sourceKey={initialTargets ? `targets:${initialTargets.updatedAt}` : "targets:empty"}
      initialTargets={initialTargets}
    />,
  );
}

vi.mock("convex/react", () => ({
  useMutation: (ref: string) => {
    if (ref === "nutrition:setTargetsMine") return mockSetTargets;
    if (ref === "nutrition:clearTargetsMine") return mockClearTargets;
    throw new Error(`Unexpected mutation ${ref}`);
  },
}));

vi.mock("../../../convex/_generated/api", () => ({
  api: {
    nutrition: {
      clearTargetsMine: "nutrition:clearTargetsMine",
      setTargetsMine: "nutrition:setTargetsMine",
    },
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

describe("NutritionTargetsForm", () => {
  beforeEach(() => {
    mockSetTargets.mockReset();
    mockClearTargets.mockReset();
    vi.mocked(toast.error).mockReset();
    vi.mocked(toast.success).mockReset();
  });

  it("creates self-set targets with blank fields omitted", async () => {
    mockSetTargets.mockResolvedValueOnce(
      createTargets({ caloriesKcal: null, proteinGrams: 180, fatGrams: 0 }),
    );
    renderForm();
    fireEvent.change(screen.getByLabelText("Protein (g)"), { target: { value: "180" } });
    fireEvent.change(screen.getByLabelText("Fat (g)"), { target: { value: "0" } });

    fireEvent.click(screen.getByRole("button", { name: "Save targets" }));

    await waitFor(() => {
      expect(mockSetTargets).toHaveBeenCalledWith({ proteinGrams: 180, fatGrams: 0 });
    });
    expect(toast.success).toHaveBeenCalledWith("Nutrition targets saved");
  });

  it("updates loaded targets", async () => {
    mockSetTargets.mockResolvedValueOnce(createTargets({ proteinGrams: 185 }));
    renderForm(createTargets());

    fireEvent.change(screen.getByLabelText("Protein (g)"), { target: { value: "185" } });
    fireEvent.click(screen.getByRole("button", { name: "Update targets" }));

    await waitFor(() => {
      expect(mockSetTargets).toHaveBeenCalledWith({
        caloriesKcal: 2_400,
        proteinGrams: 185,
        fatGrams: 75,
      });
    });
    expect(toast.success).toHaveBeenCalledWith("Nutrition targets updated");
  });

  it("locks duplicate target saves while pending", async () => {
    const save = createDeferred<NutritionTargets>();
    mockSetTargets.mockReturnValueOnce(save.promise);
    renderForm();
    fireEvent.change(screen.getByLabelText("Protein (g)"), { target: { value: "180" } });
    const form = screen.getByRole("button", { name: "Save targets" }).closest("form");
    if (!form) throw new Error("Expected the nutrition targets form");

    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });

    expect(mockSetTargets).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Saving targets" })).toBeDisabled();
    await act(async () => save.resolve(createTargets()));
  });

  it("restores the target action and focuses a save error", async () => {
    mockSetTargets.mockRejectedValueOnce(new Error("Target save unavailable"));
    renderForm();
    fireEvent.change(screen.getByLabelText("Protein (g)"), { target: { value: "180" } });

    fireEvent.click(screen.getByRole("button", { name: "Save targets" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Target save unavailable");
    await waitFor(() => expect(alert).toHaveFocus());
    expect(screen.getByRole("button", { name: "Save targets" })).toBeEnabled();
    expect(toast.error).toHaveBeenCalledWith("Target save unavailable");
  });

  it("clears confirmed targets without allowing a conflicting save", async () => {
    const clearing = createDeferred<null>();
    mockClearTargets.mockReturnValueOnce(clearing.promise);
    renderForm(createTargets());
    const updateButton = screen.getByRole("button", { name: "Update targets" });
    fireEvent.click(screen.getByRole("button", { name: "Clear targets" }));

    expect(screen.getByRole("heading", { name: "Clear your nutrition targets?" })).toBeVisible();
    expect(screen.getByText(/Your daily logs are not affected/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Clear targets" }));

    expect(mockClearTargets).toHaveBeenCalledWith({});
    const pendingClear = screen.getByRole("button", { name: "Clearing targets" });
    expect(pendingClear).toBeDisabled();
    expect(updateButton).toBeDisabled();
    fireEvent.click(pendingClear);
    fireEvent.click(updateButton);
    expect(mockClearTargets).toHaveBeenCalledTimes(1);
    expect(mockSetTargets).not.toHaveBeenCalled();

    await act(async () => clearing.resolve(null));

    expect(toast.success).toHaveBeenCalledWith("Nutrition targets cleared");
    expect(screen.getByLabelText("Calories (kcal)")).toHaveValue(null);
    expect(
      screen.queryByRole("heading", { name: "Clear your nutrition targets?" }),
    ).not.toBeInTheDocument();
  });

  it("keeps confirmation open and reports a rejected clear", async () => {
    mockClearTargets.mockRejectedValueOnce(new Error("Clear unavailable"));
    renderForm(createTargets());
    fireEvent.click(screen.getByRole("button", { name: "Clear targets" }));

    fireEvent.click(screen.getByRole("button", { name: "Clear targets" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Clear unavailable");
    expect(screen.getByRole("heading", { name: "Clear your nutrition targets?" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Clear targets" })).toBeEnabled();
    expect(toast.error).toHaveBeenCalledWith("Clear unavailable");
  });
});
