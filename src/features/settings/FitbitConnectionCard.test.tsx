import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FitbitConnectionCard } from "./FitbitConnectionCard";

const mockStartOAuth = vi.fn();
const mockRefreshFitbitData = vi.fn();
const mockDisconnectFitbit = vi.fn();
let mockStatus: unknown;

vi.mock("convex/react", () => ({
  useQuery: () => mockStatus,
  useAction: (ref: string) => {
    if (ref === "fitbit:oauthFlow:startFitbitOAuth") return mockStartOAuth;
    if (ref === "fitbit:sync:refreshFitbitData") return mockRefreshFitbitData;
    if (ref === "fitbit:sync:disconnectMyFitbit") return mockDisconnectFitbit;
    throw new Error(`Unexpected action ${ref}`);
  },
}));

vi.mock("../../../convex/_generated/api", () => ({
  api: {
    fitbit: {
      connections: {
        getMyFitbitStatus: "fitbit:connections:getMyFitbitStatus",
      },
      oauthFlow: {
        startFitbitOAuth: "fitbit:oauthFlow:startFitbitOAuth",
      },
      sync: {
        disconnectMyFitbit: "fitbit:sync:disconnectMyFitbit",
        refreshFitbitData: "fitbit:sync:refreshFitbitData",
      },
    },
  },
}));

describe("FitbitConnectionCard", () => {
  beforeEach(() => {
    mockStartOAuth.mockReset();
    mockRefreshFitbitData.mockReset();
    mockDisconnectFitbit.mockReset();
    mockStatus = {
      state: "active",
      connectedAt: Date.UTC(2026, 6, 20),
      lastSyncedAt: Date.UTC(2026, 6, 21, 18, 30),
      scopes: [
        "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
        "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
        "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
      ],
    };
  });

  it("renders connected details with readable scope labels", () => {
    render(<FitbitConnectionCard configured />);

    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Fitbit via Google Health")).toBeInTheDocument();
    expect(screen.getByText("Activity & fitness")).toBeInTheDocument();
    expect(screen.getByText("Resting HR & HRV")).toBeInTheDocument();
    expect(screen.getByText("Sleep")).toBeInTheDocument();
    expect(screen.getByText("Connected Jul 20, 2026")).toBeInTheDocument();
    expect(screen.getByText("Last synced Jul 21, 2026, 6:30 PM")).toBeInTheDocument();
    expect(
      screen.queryByText(
        "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sync now/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^disconnect$/i })).toBeEnabled();
  });

  it("uses a compact loading state while status is unresolved", () => {
    mockStatus = undefined;

    render(<FitbitConnectionCard configured />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading Fitbit status…");
  });

  it("renders a disconnected state with a readable reason and one-way sync copy", () => {
    mockStatus = {
      state: "disconnected",
      connectedAt: Date.UTC(2026, 6, 20),
      disconnectedAt: Date.UTC(2026, 6, 22),
      reason: "permission_revoked",
      scopes: [],
    };

    render(<FitbitConnectionCard configured />);

    expect(screen.getByText("Disconnected")).toBeInTheDocument();
    expect(screen.getByText(/Permission revoked/)).toBeInTheDocument();
    expect(screen.getByText(/Data flows one way from Fitbit/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /connect fitbit/i })).toBeEnabled();
  });

  it("reports imported workout and wellness counts after a sync", async () => {
    mockRefreshFitbitData.mockResolvedValueOnce({
      success: true,
      activities: 3,
      wellnessDays: 1,
    });

    render(<FitbitConnectionCard configured />);

    fireEvent.click(screen.getByRole("button", { name: /sync now/i }));

    expect(
      await screen.findByText("Fitbit synced 3 workouts and 1 wellness day."),
    ).toBeInTheDocument();
    expect(mockRefreshFitbitData).toHaveBeenCalledWith({});
  });

  it("disables every control while disconnecting and reports cleanup with revocation warnings", async () => {
    let resolveDisconnect!: (result: { success: true; warning: string }) => void;
    mockDisconnectFitbit.mockReturnValueOnce(
      new Promise<{ success: true; warning: string }>((resolve) => {
        resolveDisconnect = resolve;
      }),
    );

    render(<FitbitConnectionCard configured />);

    fireEvent.click(screen.getByRole("button", { name: /^disconnect$/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /disconnecting/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: /sync now/i })).toBeDisabled();
    });

    await act(async () => {
      resolveDisconnect({
        success: true,
        warning: "Google token revocation failed; local Fitbit data was disconnected.",
      });
    });

    expect(await screen.findByText(/Local imported Fitbit data is being removed/i)).toBeVisible();
    expect(screen.getByText(/Google token revocation failed/i)).toBeVisible();
  });

  it("discloses Fitbit data use and waits for explicit confirmation before starting OAuth", async () => {
    mockStatus = { state: "none" };
    mockStartOAuth.mockResolvedValueOnce({
      success: false,
      error: "Fitbit integration is not available on this deployment.",
    });

    render(<FitbitConnectionCard configured />);

    fireEvent.click(screen.getByRole("button", { name: /connect fitbit/i }));

    const dialog = screen.getByRole("dialog", { name: /connect fitbit to roni/i });
    expect(mockStartOAuth).not.toHaveBeenCalled();
    expect(dialog).toHaveTextContent(/read-only access to your Fitbit activity and workouts/i);
    expect(dialog).toHaveTextContent(/sleep, resting heart rate, and HRV/i);
    expect(dialog).toHaveTextContent(/up to 30 days/i);
    expect(dialog).toHaveTextContent(/Roni and its Gemini coach/i);
    expect(dialog).toHaveTextContent(/Convex, Vercel, and Google AI/i);
    expect(dialog).toHaveTextContent(/not sold or used for advertising/i);
    expect(dialog).toHaveTextContent(/never writes to Fitbit/i);
    expect(dialog).toHaveTextContent(/grant only a subset of access/i);
    expect(dialog).toHaveTextContent(/Disconnecting asks Google to revoke access/i);
    expect(dialog).toHaveTextContent(/Deleting your Roni account removes stored Fitbit/i);
    expect(within(dialog).getByRole("link", { name: /privacy policy/i })).toHaveAttribute(
      "href",
      "/privacy",
    );

    fireEvent.click(within(dialog).getByRole("button", { name: /continue to google/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Fitbit integration is not available on this deployment.");
    expect(mockStartOAuth).toHaveBeenCalledTimes(1);
    expect(mockStartOAuth).toHaveBeenCalledWith({});
    expect(screen.getByRole("button", { name: /connect fitbit/i })).toBeEnabled();
  });

  it("keeps the consent dialog open and disables its actions while OAuth is starting", async () => {
    mockStatus = { state: "none" };
    let resolveStart!: (result: { success: false; error: string }) => void;
    mockStartOAuth.mockReturnValueOnce(
      new Promise<{ success: false; error: string }>((resolve) => {
        resolveStart = resolve;
      }),
    );

    render(<FitbitConnectionCard configured />);

    fireEvent.click(screen.getByRole("button", { name: /connect fitbit/i }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /continue to google/i }));

    await waitFor(() => {
      expect(within(dialog).getByRole("button", { name: /opening google/i })).toBeDisabled();
      expect(within(dialog).getByRole("button", { name: /cancel/i })).toBeDisabled();
    });

    await act(async () => {
      resolveStart({ success: false, error: "Connection could not start." });
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("Connection could not start.");
  });

  it("keeps Disconnect available but disables Sync when configuration is unavailable", () => {
    render(<FitbitConnectionCard configured={false} />);

    expect(screen.getByRole("button", { name: /sync now/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^disconnect$/i })).toBeEnabled();
    expect(screen.getByText(/Fitbit sync is unavailable/i)).toBeVisible();
  });

  it("disables Connect when configuration is unavailable", () => {
    mockStatus = { state: "none" };

    render(<FitbitConnectionCard configured={false} />);

    expect(screen.getByRole("button", { name: /connect fitbit/i })).toBeDisabled();
    expect(screen.getByText(/Fitbit connection is unavailable/i)).toBeVisible();
    expect(mockStartOAuth).not.toHaveBeenCalled();
  });

  it("surfaces thrown sync failures without leaving controls locked", async () => {
    mockRefreshFitbitData.mockRejectedValueOnce(new Error("Fitbit service unavailable."));

    render(<FitbitConnectionCard configured />);

    fireEvent.click(screen.getByRole("button", { name: /sync now/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Fitbit service unavailable.");
    expect(screen.getByRole("button", { name: /sync now/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^disconnect$/i })).toBeEnabled();
  });
});
