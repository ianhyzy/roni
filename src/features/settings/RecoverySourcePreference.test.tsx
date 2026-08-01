import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { RecoverySourcePreference } from "./RecoverySourcePreference";

const mockSetPreference = vi.fn();
let mockPreference: unknown;
let mockGarminStatus: unknown;
let mockFitbitStatus: unknown;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

vi.mock("convex/react", () => ({
  useMutation: () => mockSetPreference,
  useQuery: (ref: string) => {
    if (ref === "recoveryPreferences:getMine") return mockPreference;
    if (ref === "garmin:connections:getMyGarminStatus") return mockGarminStatus;
    if (ref === "fitbit:connections:getMyFitbitStatus") return mockFitbitStatus;
    throw new Error(`Unexpected query ${ref}`);
  },
}));

vi.mock("../../../convex/_generated/api", () => ({
  api: {
    recoveryPreferences: {
      getMine: "recoveryPreferences:getMine",
      setMine: "recoveryPreferences:setMine",
    },
    garmin: {
      connections: { getMyGarminStatus: "garmin:connections:getMyGarminStatus" },
    },
    fitbit: {
      connections: { getMyFitbitStatus: "fitbit:connections:getMyFitbitStatus" },
    },
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

describe("RecoverySourcePreference", () => {
  beforeEach(() => {
    mockSetPreference.mockReset();
    vi.mocked(toast.error).mockReset();
    vi.mocked(toast.success).mockReset();
    mockPreference = { preferredSource: null };
    mockGarminStatus = { state: "active" };
    mockFitbitStatus = { state: "disconnected" };
  });

  it("renders a non-interactive loading state until every source query resolves", () => {
    mockPreference = undefined;

    render(<RecoverySourcePreference />);

    expect(
      screen.getByRole("status", { name: "Loading recovery source preference" }),
    ).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("always allows Automatic and disables providers that are not active", () => {
    render(<RecoverySourcePreference />);

    expect(screen.getByRole("button", { name: "Automatic" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Automatic" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Garmin" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Fitbit" })).toBeDisabled();
  });

  it("keeps a stale stored provider selected while explaining automatic fallback", () => {
    mockPreference = { preferredSource: "fitbit" };

    render(<RecoverySourcePreference />);

    expect(screen.getByRole("button", { name: "Fitbit" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Fitbit" })).toBeDisabled();
    expect(screen.getByText(/Fitbit is not currently connected/i)).toBeVisible();
    expect(screen.getByText(/automatically use another fresh source/i)).toBeVisible();
  });

  it("saves an active provider once and locks the source control while pending", async () => {
    const save = createDeferred<unknown>();
    mockSetPreference.mockReturnValueOnce(save.promise);
    render(<RecoverySourcePreference />);

    fireEvent.click(screen.getByRole("button", { name: "Garmin" }));

    expect(mockSetPreference).toHaveBeenCalledWith({ preferredSource: "garmin" });
    expect(screen.getByRole("group", { name: "Primary recovery source" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByRole("button", { name: "Automatic" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Garmin" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Garmin" }));
    expect(mockSetPreference).toHaveBeenCalledTimes(1);

    await act(async () => save.resolve({ preferredSource: "garmin" }));

    expect(toast.success).toHaveBeenCalledWith("Recovery source saved");
  });

  it("clears a saved provider by returning to Automatic", async () => {
    mockPreference = { preferredSource: "garmin" };
    mockSetPreference.mockResolvedValueOnce({ preferredSource: null });
    render(<RecoverySourcePreference />);

    fireEvent.click(screen.getByRole("button", { name: "Automatic" }));

    await waitFor(() => {
      expect(mockSetPreference).toHaveBeenCalledWith({ preferredSource: null });
    });
    expect(toast.success).toHaveBeenCalledWith("Recovery source saved");
  });

  it("surfaces a save failure and restores available choices", async () => {
    mockSetPreference.mockRejectedValueOnce(new Error("offline"));
    render(<RecoverySourcePreference />);

    fireEvent.click(screen.getByRole("button", { name: "Garmin" }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Could not save recovery source. Try again.");
    });
    expect(screen.getByRole("button", { name: "Automatic" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Garmin" })).toBeEnabled();
  });
});
