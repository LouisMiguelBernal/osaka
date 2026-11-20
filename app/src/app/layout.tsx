import type { Metadata } from "next";
import Link from "next/link";
import { Fragment_Mono, Instrument_Serif } from "next/font/google";
import "./globals.css";

const serif = Instrument_Serif({ weight: "400", subsets: ["latin"], variable: "--font-instrument-serif", display: "swap" });
const mono = Fragment_Mono({ weight: "400", subsets: ["latin"], variable: "--font-fragment-mono", display: "swap" });

export const metadata: Metadata = {
  title: { default: "OSAKA", template: "OSAKA · %s" },
  description: "Local-first document intake: PDFs in, structured fields out, humans approve.",
};

/** The OSAKA hanko: vermilion seal, ring, check. Same mark as src/app/icon.svg. */
function Seal({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 96 96" aria-hidden className={className}>
      <rect x="4" y="4" width="88" height="88" rx="6" fill="#C8372D" />
      <rect x="11" y="11" width="74" height="74" rx="3" fill="none" stroke="#F4F1EA" strokeWidth="2.5" />
      <circle cx="48" cy="48" r="22" fill="none" stroke="#F4F1EA" strokeWidth="7" />
      <path d="M38 48.5 L45.5 56 L60 40.5" fill="none" stroke="#F4F1EA" strokeWidth="6" strokeLinecap="square" strokeLinejoin="miter" />
    </svg>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${mono.variable}`}>
      <body className="min-h-screen">
        <header className="border-b border-[var(--color-rule)]">
          <div className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-3">
            <Link href="/inbox" className="flex items-center gap-2.5">
              <Seal className="h-7 w-7 -rotate-3" />
              <span className="display text-[1.6rem] tracking-[0.04em]">OSAKA</span>
            </Link>
            <nav className="label text-[var(--color-muted)]">
              <Link href="/inbox" className="hover:text-[var(--color-ink)]">Inbox</Link>
            </nav>
            <span className="label ml-auto hidden text-[var(--color-muted)] sm:inline">Local model · data stays on this machine</span>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
