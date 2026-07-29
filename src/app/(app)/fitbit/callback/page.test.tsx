import { StrictMode } from "react";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import FitbitCallbackPage from "./page";

const mockCompleteOAuth = vi.fn();
const mockReplace = vi.fn();
const mockRouter = { replace: mockReplace };
let mockSearchParams = new URLSearchParams();

vi.mock("convex/react", () => ({
  useAction: () => mockCompleteOAuth,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => mockSearchParams,
}));

vi.mock("../../../../../convex/_generated/api", () => ({
  api: {
    fitbit: {
      oauthFlow: {
        completeFitbitOAuth: "fitbit:oauthFlow:completeFitbitOAuth",
      },
    },
  },
}));

describe("FitbitCallbackPage", () => {
  beforeEach(() => {
    mockCompleteOAuth.mockReset();
    mockReplace.mockReset();
    mockSearchParams = new URLSearchParams();
  });

  it("redirects a missing ticket without reading or forwarding OAuth parameters", async () => {
    mockSearchParams = new URLSearchParams({ code: "code-1", state: "state-1" });
    const getSpy = vi.spyOn(mockSearchParams, "get");

    render(<FitbitCallbackPage />);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/settings?fitbit=error&reason=missing_params");
    });
    expect(mockCompleteOAuth).not.toHaveBeenCalled();
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(getSpy).toHaveBeenCalledWith("ticket");
  });

  it("trims the ticket, completes OAuth once in Strict Mode, and redirects successfully", async () => {
    mockSearchParams = new URLSearchParams({
      ticket: " ticket-1 ",
      code: "must-not-be-read",
      state: "must-not-be-read",
    });
    const getSpy = vi.spyOn(mockSearchParams, "get");
    mockCompleteOAuth.mockResolvedValue({ success: true });

    render(
      <StrictMode>
        <FitbitCallbackPage />
      </StrictMode>,
    );

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/settings?fitbit=connected");
    });
    expect(mockCompleteOAuth).toHaveBeenCalledTimes(1);
    expect(mockCompleteOAuth).toHaveBeenCalledWith({ ticket: "ticket-1" });
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(getSpy).toHaveBeenCalledWith("ticket");
  });

  it("redirects rejected callbacks with an encoded error reason", async () => {
    mockSearchParams = new URLSearchParams({ ticket: "ticket-1" });
    mockCompleteOAuth.mockResolvedValue({ success: false, error: "State expired & retry" });

    render(<FitbitCallbackPage />);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith(
        "/settings?fitbit=error&reason=State%20expired%20%26%20retry",
      );
    });
  });

  it("redirects thrown completion errors with an encoded reason", async () => {
    mockSearchParams = new URLSearchParams({ ticket: "ticket-1" });
    mockCompleteOAuth.mockRejectedValue(new Error("Ticket invalid? Try again"));

    render(<FitbitCallbackPage />);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith(
        "/settings?fitbit=error&reason=Ticket%20invalid%3F%20Try%20again",
      );
    });
  });
});
