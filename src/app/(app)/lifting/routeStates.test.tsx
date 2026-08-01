import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LiftingError from "./error";
import LiftingLoading from "./loading";

const mockCaptureMessage = vi.hoisted(() => vi.fn());

vi.mock("@sentry/nextjs", () => ({
  captureMessage: mockCaptureMessage,
}));

describe("lifting route states", () => {
  beforeEach(() => {
    mockCaptureMessage.mockReset();
  });

  it("offers retry and a dashboard return when loading fails", () => {
    const reset = vi.fn();
    const rawMessage = "database-password-leaked-in-error";
    const error = Object.assign(new Error(rawMessage), { digest: "digest-123" });

    render(<LiftingError error={error} reset={reset} />);

    expect(screen.getByText("Could not load manual lifting")).toBeVisible();
    expect(screen.getByText(/Your sessions are still safe/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Back to dashboard" })).toHaveAttribute(
      "href",
      "/dashboard",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage).toHaveBeenCalledWith("Lifting route rendering failed", {
      level: "error",
      tags: { route: "/lifting" },
      extra: { digest: "digest-123" },
    });
    expect(JSON.stringify(mockCaptureMessage.mock.calls)).not.toContain(rawMessage);
  });

  it("labels the route loading state", () => {
    render(<LiftingLoading />);

    expect(screen.getByRole("status", { name: "Loading manual lifting" })).toBeVisible();
  });
});
