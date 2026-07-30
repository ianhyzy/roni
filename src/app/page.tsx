import type { Metadata } from "next";
import Link from "next/link";
import { AuthCta } from "./_components/AuthCta";
import { DataTrustSection } from "./_components/DataTrustSection";
import { FaqPreview, PricingTeaser } from "./_components/HomeSections";
import { ProductMockup } from "./_components/ProductMockup";
import { SiteFooter } from "./_components/SiteFooter";
import { SiteNav } from "./_components/SiteNav";
import { Testimonials } from "./_components/Testimonials";
import { WholeWeekSection } from "./_components/WholeWeekSection";

export const metadata: Metadata = {
  title: { absolute: "Roni — Adaptive AI coaching for Tonal owners" },
  description:
    "Roni turns your Tonal training history, recovery, and cross-training context into a weekly plan with workouts you approve.",
  alternates: { canonical: "/" },
};

const TRAINING_SIGNALS = [
  "Your real Tonal history",
  "A plan that adapts weekly",
  "You approve every workout",
] as const;

export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteNav />

      <main>
        <section className="relative overflow-hidden border-b border-border px-6 pb-20 pt-16 sm:pb-28 sm:pt-24">
          <div
            className="pointer-events-none absolute inset-0 opacity-70"
            style={{
              background:
                "radial-gradient(circle at 76% 28%, oklch(0.78 0.154 195 / 18%), transparent 31%), radial-gradient(circle at 90% 58%, oklch(0.6 0.22 300 / 12%), transparent 28%)",
            }}
          />
          <div className="relative mx-auto grid max-w-6xl items-center gap-14 lg:grid-cols-[0.92fr_1.08fr]">
            <div>
              <p className="font-mono text-xs font-semibold uppercase tracking-[0.22em] text-primary">
                Training intelligence for Tonal owners
              </p>
              <h1 className="mt-6 max-w-3xl text-5xl font-bold leading-[0.98] tracking-[-0.045em] text-foreground sm:text-6xl lg:text-7xl">
                Your Tonal knows what you lifted.{" "}
                <span className="text-primary">Roni knows what to do next.</span>
              </h1>
              <p className="mt-7 max-w-xl text-lg leading-8 text-muted-foreground">
                An open-source AI coach that reads your real training history, builds the week
                around your goals and recovery, and sends approved workouts back to your Tonal.
              </p>

              <div className="mt-9 flex flex-wrap items-center gap-4">
                <AuthCta variant="hero" />
                <Link
                  href="#week"
                  className="inline-flex h-12 items-center rounded-lg border border-border bg-card/60 px-6 text-base font-medium text-foreground transition-colors hover:border-primary/50 hover:bg-card"
                >
                  See a week in Roni
                </Link>
              </div>

              <ul className="mt-8 grid gap-3 text-sm text-muted-foreground sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
                {TRAINING_SIGNALS.map((signal) => (
                  <li key={signal} className="flex items-center gap-2">
                    <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
                    {signal}
                  </li>
                ))}
              </ul>
            </div>

            <ProductMockup />
          </div>
        </section>

        <section className="border-b border-border bg-card/30 px-6 py-5">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-8 gap-y-3 text-center font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground">
            <span>Training history</span>
            <span className="text-primary" aria-hidden="true">
              +
            </span>
            <span>Recovery context</span>
            <span className="text-primary" aria-hidden="true">
              +
            </span>
            <span>Cross-training load</span>
            <span className="text-primary" aria-hidden="true">
              →
            </span>
            <span className="text-foreground">One useful week</span>
          </div>
        </section>

        <WholeWeekSection />
        <Testimonials />
        <DataTrustSection />
        <FaqPreview />

        <section className="border-t border-border px-6 py-20 sm:py-24">
          <div className="mx-auto grid max-w-6xl gap-10 rounded-3xl border border-border bg-card px-7 py-10 sm:px-10 lg:grid-cols-[1fr_auto] lg:items-center">
            <div>
              <p className="font-mono text-xs font-semibold uppercase tracking-[0.2em] text-primary">
                Workout library
              </p>
              <h2 className="mt-4 text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
                Start with a proven session. Make it yours with Coach.
              </h2>
              <p className="mt-4 max-w-2xl text-lg leading-8 text-muted-foreground">
                Browse more than 800 Tonal workouts by goal and muscle group, then ask Roni to adapt
                one to your history, schedule, and readiness.
              </p>
            </div>
            <Link
              href="/workouts"
              className="inline-flex h-12 items-center justify-center rounded-lg bg-foreground px-7 text-base font-semibold text-background transition-opacity hover:opacity-90"
            >
              Browse workouts
            </Link>
          </div>
        </section>

        <PricingTeaser />

        <section className="border-t border-border px-6 py-24">
          <div className="mx-auto max-w-3xl text-center">
            <p className="font-mono text-xs font-semibold uppercase tracking-[0.2em] text-primary">
              Your next week starts here
            </p>
            <h2 className="mt-5 text-4xl font-bold tracking-[-0.035em] text-foreground sm:text-6xl">
              Bring the data. Keep the decisions.
            </h2>
            <p className="mx-auto mt-6 max-w-xl text-lg leading-8 text-muted-foreground">
              Connect your Tonal, tell Roni what you are training for, and approve a plan built for
              the week you actually have.
            </p>
            <div className="mt-9">
              <AuthCta variant="bottom" />
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
