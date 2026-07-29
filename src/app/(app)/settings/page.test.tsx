import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SettingsPage from "./page";

const mockGetFitbitFeatureStatus = vi.fn();
const mockOtherAction = vi.fn();
const mockSignOut = vi.fn();

vi.mock("convex/react", () => ({
  useAction: (ref: string) =>
    ref === "fitbit:connections:getFitbitFeatureStatus"
      ? mockGetFitbitFeatureStatus
      : mockOtherAction,
  useQuery: (ref: string) => {
    if (ref === "users:getMe") {
      return { email: "athlete@example.com", hasTonalProfile: false };
    }
    if (ref === "garmin:connections:getGarminFeatureStatus") {
      return { enabled: false };
    }
    if (ref === "fitbit:connections:getMyFitbitStatus") {
      return {
        state: "active",
        connectedAt: Date.UTC(2026, 6, 20),
        scopes: [],
      };
    }
    return undefined;
  },
}));

vi.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({ signOut: mockSignOut }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/analytics", () => ({
  usePageView: vi.fn(),
}));

vi.mock("../../../../convex/_generated/api", () => ({
  api: {
    users: { getMe: "users:getMe" },
    garmin: {
      connections: {
        getGarminFeatureStatus: "garmin:connections:getGarminFeatureStatus",
      },
    },
    fitbit: {
      connections: {
        getFitbitFeatureStatus: "fitbit:connections:getFitbitFeatureStatus",
        getMyFitbitStatus: "fitbit:connections:getMyFitbitStatus",
      },
      oauthFlow: { startFitbitOAuth: "fitbit:oauthFlow:startFitbitOAuth" },
      sync: {
        disconnectMyFitbit: "fitbit:sync:disconnectMyFitbit",
        refreshFitbitData: "fitbit:sync:refreshFitbitData",
      },
    },
  },
}));

vi.mock("@/features/settings/CheckInPreferences", () => ({
  CheckInPreferences: () => null,
}));
vi.mock("@/features/settings/ChangePassword", () => ({ ChangePassword: () => null }));
vi.mock("@/features/settings/EmailChange", () => ({ EmailChange: () => null }));
vi.mock("@/features/settings/EquipmentSettings", () => ({ EquipmentSettings: () => null }));
vi.mock("@/features/settings/ExerciseExclusions", () => ({ ExerciseExclusions: () => null }));
vi.mock("@/features/settings/MemoryFacts", () => ({ MemoryFacts: () => null }));
vi.mock("@/features/settings/DataExport", () => ({ DataExport: () => null }));
vi.mock("@/features/settings/DeleteAccount", () => ({ DeleteAccount: () => null }));
vi.mock("@/features/settings/ProfileCard", () => ({ ProfileCard: () => null }));
vi.mock("@/features/settings/TonalConnectionCard", () => ({
  TonalConnectionCard: () => null,
}));
vi.mock("@/features/settings/GarminConnectionCard", () => ({
  GarminConnectionCard: () => null,
}));
vi.mock("@/features/byok/ProviderSection", () => ({ ProviderSection: () => null }));

describe("SettingsPage Fitbit availability", () => {
  beforeEach(() => {
    mockGetFitbitFeatureStatus.mockReset();
    mockOtherAction.mockReset();
    mockSignOut.mockReset();
  });

  it("keeps an existing connection manageable while availability fails and after retry", async () => {
    mockGetFitbitFeatureStatus
      .mockRejectedValueOnce(new Error("Temporary failure"))
      .mockResolvedValueOnce({ enabled: false, hasConnection: true });

    render(<SettingsPage />);

    expect(
      await screen.findByText(
        "Could not check Fitbit availability. Existing connections are not affected.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "Fitbit Connection" })).toBeVisible();
    expect(screen.getByRole("button", { name: /sync now/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^disconnect$/i })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(mockGetFitbitFeatureStatus).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      expect(
        screen.queryByText(
          "Could not check Fitbit availability. Existing connections are not affected.",
        ),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByRole("heading", { name: "Fitbit Connection" })).toBeVisible();
    expect(screen.getByRole("button", { name: /sync now/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^disconnect$/i })).toBeEnabled();
  });
});
