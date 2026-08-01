import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StravaConnectionCard } from "./StravaConnectionCard";

const mockStartOAuth = vi.fn();
const mockRefreshData = vi.fn();
const mockDisconnect = vi.fn();
let mockStatus: unknown;

vi.mock("convex/react", () => ({
  useQuery: () => mockStatus,
  useAction: (ref: string) => {
    if (ref === "strava:oauthFlow:startStravaOAuth") return mockStartOAuth;
    if (ref === "strava:sync:refreshStravaData") return mockRefreshData;
    if (ref === "strava:disconnect:disconnectMyStrava") return mockDisconnect;
    throw new Error(`Unexpected action ${ref}`);
  },
}));

vi.mock("../../../convex/_generated/api", () => ({
  api: {
    strava: {
      status: { getMyStravaStatus: "strava:status:getMyStravaStatus" },
      oauthFlow: { startStravaOAuth: "strava:oauthFlow:startStravaOAuth" },
      sync: { refreshStravaData: "strava:sync:refreshStravaData" },
      disconnect: { disconnectMyStrava: "strava:disconnect:disconnectMyStrava" },
    },
  },
}));

describe("StravaConnectionCard", () => {
  beforeEach(() => {
    mockStartOAuth.mockReset();
    mockRefreshData.mockReset();
    mockDisconnect.mockReset();
    mockStatus = {
      state: "active",
      connectedAt: Date.UTC(2026, 6, 20, 12),
      lastSyncedAt: Date.UTC(2026, 6, 21, 18, 30),
      scopes: ["activity:read"],
    };
  });

  it("states the narrow read-only capability boundary", () => {
    render(<StravaConnectionCard configured />);

    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Public activities only")).toBeInTheDocument();
    expect(screen.getByText(/Imports activity summaries for training-load context/i)).toBeVisible();
    expect(
      screen.getByText(/read-only access to public activities \(activity:read\)/i),
    ).toBeVisible();
    expect(screen.getByText(/private activities are not imported/i)).toBeVisible();
    expect(screen.getByText(/does not include lifting sets or reps/i)).toBeVisible();
    expect(screen.getByText(/change Tonal strength scores/i)).toBeVisible();
    expect(screen.getByText(/detect PRs/i)).toBeVisible();
    expect(screen.getByText(/publish workouts/i)).toBeVisible();
    expect(screen.getByText("Connected Jul 20, 2026, 12:00 PM UTC")).toBeVisible();
    expect(screen.getByText("Last synced Jul 21, 2026, 6:30 PM UTC")).toBeVisible();
  });

  it("renders an accessible loading state", () => {
    mockStatus = undefined;

    render(<StravaConnectionCard configured />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading Strava status…");
  });

  it("reports imported activity count after a manual sync", async () => {
    mockRefreshData.mockResolvedValue({ success: true, activities: 2 });

    render(<StravaConnectionCard configured />);
    const statusRegion = screen.getByRole("status");
    expect(statusRegion).toHaveAttribute("aria-live", "polite");
    expect(statusRegion).toBeEmptyDOMElement();

    fireEvent.click(screen.getByRole("button", { name: /sync now/i }));

    expect(await within(statusRegion).findByText("Strava synced 2 activities.")).toBeVisible();
    expect(mockRefreshData).toHaveBeenCalledWith({});
  });

  it("surfaces a thrown sync error without leaving controls locked", async () => {
    mockRefreshData.mockRejectedValue(new Error("Strava service unavailable."));

    render(<StravaConnectionCard configured />);
    fireEvent.click(screen.getByRole("button", { name: /sync now/i }));

    expect(await screen.findByText("Strava service unavailable.")).toBeVisible();
    expect(screen.getByRole("button", { name: /sync now/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^disconnect$/i })).toBeEnabled();
  });

  it("reports a failed manual sync without leaving controls locked", async () => {
    mockRefreshData.mockResolvedValue({ success: false, error: "Strava sync is unavailable." });

    render(<StravaConnectionCard configured />);
    const statusRegion = screen.getByRole("status");
    fireEvent.click(screen.getByRole("button", { name: /sync now/i }));

    expect(await within(statusRegion).findByText("Strava sync is unavailable.")).toBeVisible();
    expect(statusRegion).toHaveAttribute("aria-live", "polite");
    expect(statusRegion).toHaveAttribute("aria-atomic", "true");
    expect(screen.getByRole("button", { name: /sync now/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^disconnect$/i })).toBeEnabled();
  });

  it("requires confirmation before deleting imports and explains failed revocation", async () => {
    mockDisconnect.mockResolvedValue({ success: true, revocation: "failed" });

    render(<StravaConnectionCard configured />);
    fireEvent.click(screen.getByRole("button", { name: /^disconnect$/i }));

    expect(mockDisconnect).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Disconnect Strava?" });
    expect(dialog).toHaveTextContent(/delete your imported Strava activities/i);
    expect(dialog).toHaveTextContent(/does not delete anything from Strava/i);
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect Strava" }));

    await waitFor(() => expect(mockDisconnect).toHaveBeenCalledWith({}));
    expect(await screen.findByText(/local imported data was removed/i)).toBeVisible();
    expect(screen.getByRole("link", { name: /Review Strava connected apps/i })).toHaveAttribute(
      "href",
      "https://www.strava.com/settings/apps",
    );
  });

  it("keeps disconnect available when deployment configuration is unavailable", () => {
    render(<StravaConnectionCard configured={false} />);

    expect(screen.getByRole("button", { name: /sync now/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^disconnect$/i })).toBeEnabled();
    expect(screen.getByText(/You can still disconnect/i)).toBeVisible();
  });

  it("reports a retryable disconnect failure after confirmation", async () => {
    mockDisconnect.mockResolvedValue({
      success: false,
      retryable: true,
      error: "Strava is finishing a token refresh.",
    });

    render(<StravaConnectionCard configured />);
    fireEvent.click(screen.getByRole("button", { name: /^disconnect$/i }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Disconnect Strava" }),
    );

    expect(await screen.findByText("Strava is finishing a token refresh.")).toBeVisible();
    expect(screen.getByRole("button", { name: /^disconnect$/i })).toBeEnabled();
  });

  it("disables connect when configuration is unavailable", () => {
    mockStatus = { state: "none" };

    render(<StravaConnectionCard configured={false} />);

    expect(screen.getByRole("button", { name: /connect strava/i })).toBeDisabled();
    expect(screen.getByText(/connection is unavailable/i)).toBeVisible();
  });

  it("surfaces a failed connection start without leaving the button locked", async () => {
    mockStatus = { state: "none" };
    mockStartOAuth.mockResolvedValue({ success: false, error: "Strava is unavailable." });

    render(<StravaConnectionCard configured />);
    fireEvent.click(screen.getByRole("button", { name: /connect strava/i }));

    expect(await screen.findByText("Strava is unavailable.")).toBeVisible();
    expect(screen.getByRole("button", { name: /connect strava/i })).toBeEnabled();
  });
});
