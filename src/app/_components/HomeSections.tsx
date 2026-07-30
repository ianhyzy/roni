import Link from "next/link";
import { AuthCta } from "./AuthCta";

/* ------------------------------------------------------------------ */
/*  Data                                                                */
/* ------------------------------------------------------------------ */

interface FaqItem {
  q: string;
  a: string;
}

const FAQ_ITEMS: FaqItem[] = [
  {
    q: "Is Roni free?",
    a: "Yes, completely free and open source. No credit card required. You bring your own Google Gemini API key (free from Google AI Studio) so the AI runs on your quota, not ours.",
  },
  {
    q: "Is it safe to connect my Tonal account?",
    a: "Yes. Your credentials are used once to obtain an access token and are never stored. The token is encrypted with AES-256-GCM. We only access workout history, strength scores, and movement data.",
  },
  {
    q: "How does the AI coaching work?",
    a: "The AI analyzes your training history, strength trends, and recovery patterns to build personalized programs. It applies progressive overload, periodization, and injury awareness — grounded in your actual data.",
  },
  {
    q: "How is this different from Tonal's built-in programs?",
    a: "Tonal's programs are pre-built for general audiences. Roni creates fully custom programs based on your data — your lifts, recovery, goals, and injuries. It adapts week to week as your performance changes.",
  },
];

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ_ITEMS.map(({ q, a }) => ({
    "@type": "Question",
    name: q,
    acceptedAnswer: { "@type": "Answer", text: a },
  })),
};

/* ------------------------------------------------------------------ */
/*  Sections                                                            */
/* ------------------------------------------------------------------ */

export function FaqPreview() {
  return (
    <section className="border-t border-border px-6 py-20 sm:py-24">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      <div className="mx-auto max-w-3xl">
        <h2 className="scroll-fade-up mb-10 text-center text-3xl font-bold tracking-tight text-foreground">
          Common Questions
        </h2>
        <div className="divide-y divide-border">
          {FAQ_ITEMS.map(({ q, a }) => (
            <details key={q} className="group py-4">
              <summary className="cursor-pointer list-none font-medium text-foreground transition-colors hover:text-primary">
                {q}
              </summary>
              <p className="mt-3 leading-relaxed text-muted-foreground">{a}</p>
            </details>
          ))}
        </div>
        <p className="mt-8 text-center">
          <Link
            href="/faq"
            className="text-sm font-medium text-primary underline underline-offset-2 transition-colors hover:text-foreground"
          >
            See all questions &rarr;
          </Link>
        </p>
      </div>
    </section>
  );
}

export function PricingTeaser() {
  return (
    <section className="border-t border-border px-6 py-20 sm:py-24">
      <div className="mx-auto max-w-md">
        <div
          className="scroll-scale-in rounded-2xl p-[1px]"
          style={{
            background: "linear-gradient(135deg, oklch(0.78 0.154 195), oklch(0.6 0.22 300))",
          }}
        >
          <div className="rounded-[15px] bg-card px-8 py-10 text-center">
            <p
              className="mb-2 text-xs font-medium uppercase tracking-widest"
              style={{ color: "oklch(0.78 0.154 195)" }}
            >
              Open Source
            </p>
            <span
              className="text-6xl font-bold tracking-tight"
              style={{ color: "oklch(0.78 0.154 195)" }}
            >
              $0
            </span>
            <p className="mt-2 text-muted-foreground">Forever free to use</p>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground/70">
              Bring your own Google Gemini API key (free from Google AI Studio) so the AI runs on
              your quota, not ours.
            </p>
            <div className="mt-6">
              <AuthCta variant="hero" />
            </div>
          </div>
        </div>
        <p className="mt-6 text-center">
          <Link
            href="/pricing"
            className="text-sm font-medium text-primary underline underline-offset-2 transition-colors hover:text-foreground"
          >
            See pricing details &rarr;
          </Link>
        </p>
      </div>
    </section>
  );
}
