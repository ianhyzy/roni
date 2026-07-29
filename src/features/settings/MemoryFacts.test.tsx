import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { MemoryFacts } from "./MemoryFacts";

const mockRemoveFact = vi.fn();
const mockUseQuery = vi.fn();
let mockAuth = { isAuthenticated: true, isLoading: false };
let mockFacts: unknown;

function memoryFact(overrides: Record<string, unknown> = {}) {
  return {
    id: "fact-squats",
    fact: "Prefers squats over lunges.",
    category: "exercise_preference",
    confidence: 0.96,
    createdAt: 1000,
    lastReferencedAt: 2000,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });

  return { promise, resolve };
}

vi.mock("convex/react", () => ({
  useConvexAuth: () => mockAuth,
  useMutation: () => mockRemoveFact,
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

vi.mock("../../../convex/_generated/api", () => ({
  api: {
    userMemoryFacts: {
      listMine: "userMemoryFacts:listMine",
      removeMine: "userMemoryFacts:removeMine",
    },
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

describe("MemoryFacts", () => {
  beforeEach(() => {
    mockAuth = { isAuthenticated: true, isLoading: false };
    mockFacts = [];
    mockRemoveFact.mockReset();
    mockUseQuery.mockReset();
    mockUseQuery.mockImplementation(() => mockFacts);
    vi.mocked(toast.error).mockReset();
    vi.mocked(toast.success).mockReset();
  });

  it("keeps auth and query transitions in the loading state", () => {
    mockAuth = { isAuthenticated: false, isLoading: true };
    mockFacts = undefined;
    const { rerender } = render(<MemoryFacts />);

    expect(screen.getByRole("status", { name: "Loading coach memories" })).toBeInTheDocument();
    expect(mockUseQuery).toHaveBeenLastCalledWith("userMemoryFacts:listMine", "skip");
    expect(screen.queryByText(/no saved coaching preferences/i)).not.toBeInTheDocument();

    mockAuth = { isAuthenticated: false, isLoading: false };
    rerender(<MemoryFacts />);

    expect(
      screen.queryByRole("status", { name: "Loading coach memories" }),
    ).not.toBeInTheDocument();

    mockAuth = { isAuthenticated: true, isLoading: false };
    rerender(<MemoryFacts />);

    expect(screen.getByRole("status", { name: "Loading coach memories" })).toBeInTheDocument();
    expect(mockUseQuery).toHaveBeenLastCalledWith("userMemoryFacts:listMine", {});

    mockFacts = [];
    rerender(<MemoryFacts />);

    expect(screen.getByText("No saved coaching preferences yet.")).toBeInTheDocument();
    expect(
      screen.queryByRole("status", { name: "Loading coach memories" }),
    ).not.toBeInTheDocument();
  });

  it("renders saved facts with readable category labels", () => {
    mockFacts = [
      memoryFact(),
      memoryFact({
        id: "fact-schedule",
        fact: "Usually trains before work.",
        category: "schedule_preference",
      }),
      memoryFact({
        id: "fact-style",
        fact: "Likes short, high-effort sessions.",
        category: "workout_style_preference",
      }),
    ];

    render(<MemoryFacts />);

    expect(screen.getByText("Exercise")).toBeInTheDocument();
    expect(screen.getByText("Schedule")).toBeInTheDocument();
    expect(screen.getByText("Workout style")).toBeInTheDocument();
    expect(screen.getByText("Likes short, high-effort sessions.")).toBeInTheDocument();
    expect(screen.queryByText("0.96")).not.toBeInTheDocument();
  });

  it("confirms deletion and disables only the pending row", async () => {
    const removal = deferred<{ removed: boolean }>();
    mockRemoveFact.mockReturnValueOnce(removal.promise);
    mockFacts = [
      memoryFact(),
      memoryFact({
        id: "fact-mornings",
        fact: "Usually trains in the morning.",
        category: "schedule_preference",
      }),
    ];
    render(<MemoryFacts />);

    const squatsButton = screen.getByLabelText("Forget memory: Prefers squats over lunges.");
    const morningsButton = screen.getByLabelText("Forget memory: Usually trains in the morning.");
    fireEvent.click(squatsButton);

    expect(screen.getByRole("heading", { name: "Forget this memory?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Forget memory" }));

    await waitFor(() => {
      expect(mockRemoveFact).toHaveBeenCalledWith({ factId: "fact-squats" });
      expect(squatsButton).toBeDisabled();
      expect(morningsButton).toBeEnabled();
    });

    await act(async () => {
      removal.resolve({ removed: true });
      await removal.promise;
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Memory removed");
      expect(
        screen.queryByRole("heading", { name: "Forget this memory?" }),
      ).not.toBeInTheDocument();
    });
  });

  it("keeps the confirmation open and reports a removal error", async () => {
    mockFacts = [memoryFact()];
    mockRemoveFact.mockRejectedValueOnce(new Error("Could not reach the server"));
    render(<MemoryFacts />);

    fireEvent.click(screen.getByLabelText("Forget memory: Prefers squats over lunges."));
    fireEvent.click(screen.getByRole("button", { name: "Forget memory" }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Roni couldn't remove this memory. Try again.");
    });
    expect(screen.getByRole("heading", { name: "Forget this memory?" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Roni couldn't remove this memory. Try again.",
    );
    expect(screen.getByRole("button", { name: "Forget memory" })).toBeEnabled();
  });

  it("reports when a memory was not removed", async () => {
    mockFacts = [memoryFact()];
    mockRemoveFact.mockResolvedValueOnce({ removed: false });
    render(<MemoryFacts />);

    fireEvent.click(screen.getByLabelText("Forget memory: Prefers squats over lunges."));
    fireEvent.click(screen.getByRole("button", { name: "Forget memory" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Roni couldn't remove this memory. Try again.",
    );
    expect(screen.getByRole("heading", { name: "Forget this memory?" })).toBeInTheDocument();
  });
});
