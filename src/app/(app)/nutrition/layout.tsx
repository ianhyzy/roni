import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Nutrition",
  description: "Track manual daily nutrition totals and self-set targets.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
