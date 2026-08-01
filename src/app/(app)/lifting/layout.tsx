import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Manual Lifting",
  description: "Track lifting sessions completed outside Tonal.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
