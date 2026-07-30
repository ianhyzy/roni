import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import HomePage from "./page";

let isAuthenticated = false;

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated, isLoading: false }),
}));

vi.mock("./_components/PublicOpenSourceBanner", () => ({
  PublicOpenSourceBanner: () => <div>Roni is open source.</div>,
}));

describe("HomePage", () => {
  beforeEach(() => {
    isAuthenticated = false;
  });

  it("positions Roni as a weekly coach with user-approved workout delivery", () => {
    render(<HomePage />);

    expect(
      screen.getByRole("heading", {
        name: "Your Tonal knows what you lifted. Roni knows what to do next.",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("You approve every workout")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign In" })).toHaveAttribute("href", "/login");
    const getStartedCtas = screen.getAllByRole("button", { name: "Get Started" });
    expect(getStartedCtas).toHaveLength(3);
    getStartedCtas.forEach((cta) => expect(cta).toHaveAttribute("href", "/login"));
    expect(screen.getByText("Illustrative week")).toBeInTheDocument();
  });

  it("links every authenticated call to action to chat", () => {
    isAuthenticated = true;

    render(<HomePage />);

    const chatCtas = screen.getAllByText("Go to Chat");
    expect(chatCtas).toHaveLength(4);
    chatCtas.forEach((cta) => expect(cta).toHaveAttribute("href", "/chat"));
  });

  it("states optional provider boundaries and links to the data policy", () => {
    render(<HomePage />);

    expect(screen.getByText("Fitbit")).toBeInTheDocument();
    expect(screen.getByText("Garmin")).toBeInTheDocument();
    expect(screen.getAllByText("Provider review")).toHaveLength(2);
    expect(
      screen.getByText(
        "Optional Fitbit and Garmin features remain subject to their providers' approval and may not be available to every account.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Read the full data policy" })).toHaveAttribute(
      "href",
      "/privacy",
    );
  });
});
