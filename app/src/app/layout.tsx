import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "OSAKA", template: "OSAKA · %s" },
  description: "Local-first document intake: PDFs in, structured fields out, humans approve.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="border-b border-[var(--color-line)] bg-[var(--color-surface)]">
          <div className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-3">
            <Link href="/inbox" className="flex items-center gap-2 font-bold tracking-wide">
              <span aria-hidden className="grid h-7 w-7 place-items-center rounded-full bg-[var(--color-accent)] text-white">
                <span className="h-2.5 w-2.5 rounded-full border-2 border-white" />
              </span>
              OSAKA
            </Link>
            <nav className="text-sm text-[var(--color-muted)]">
              <Link href="/inbox" className="hover:text-[var(--color-ink)]">Inbox</Link>
            </nav>
            <span className="ml-auto hidden text-xs text-[var(--color-muted)] sm:inline">Local model · data stays on this machine</span>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
