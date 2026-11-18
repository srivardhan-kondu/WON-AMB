import Link from "next/link";
import { Suspense } from "react";
import BookingWizard from "@/components/BookingWizard";

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-24 pt-6">
      <header className="mb-8 flex items-center justify-between">
        <Link href="/" className="flex items-baseline gap-2">
          <span className="text-3xl font-black tracking-tight neon-text">WON</span>
          <span className="text-xs uppercase tracking-[0.2em] text-muted">World of Neon</span>
        </Link>
        <Link href="/b" className="text-sm text-muted hover:text-foreground">
          Find my booking
        </Link>
      </header>
      <section className="mb-8">
        <h1 className="text-3xl font-bold leading-tight sm:text-4xl">
          Neon games & splatter. <span className="neon-text">Book in four taps.</span>
        </h1>
        <p className="mt-2 text-muted">Level 6, AMB Mall · Open 11 am – 10 pm · Live availability, UPI checkout, instant WhatsApp confirmation.</p>
      </section>
      <Suspense fallback={<div className="text-muted">Loading live availability…</div>}>
        <BookingWizard />
      </Suspense>
      <footer className="mt-16 border-t border-line pt-6 text-xs text-muted">
        We use your name and phone only for your booking and WON updates — never shared with third parties. Cancellations are non-refundable; one free reschedule up to 24 h ahead.
        <div className="mt-2">
          <Link href="/staff" className="hover:text-foreground">
            Staff login
          </Link>
        </div>
      </footer>
    </main>
  );
}
