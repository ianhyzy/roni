import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import NutritionError from "./error";
import NutritionLoading from "./loading";

describe("nutrition route states", () => {
  it("offers retry and a dashboard return when loading fails", () => {
    const reset = vi.fn();
    render(<NutritionError reset={reset} />);

    expect(screen.getByText("Could not load nutrition tracking")).toBeVisible();
    expect(screen.getByText(/Your saved logs are still safe/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Back to dashboard" })).toHaveAttribute(
      "href",
      "/dashboard",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("labels the route loading state", () => {
    render(<NutritionLoading />);

    expect(screen.getByRole("status", { name: "Loading nutrition tracker" })).toBeVisible();
  });
});
