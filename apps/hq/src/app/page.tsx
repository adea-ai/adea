"use client";

import Link from "next/link";
import { ThemeToggle } from "@agent-hq/ui";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-8 px-6 py-10">
      <ThemeToggle className="fixed right-4 top-4 z-50" />
      <header className="flex items-center gap-4">
        <div
          className="flex size-14 items-center justify-center rounded-2xl bg-primary text-lg font-bold text-primary-foreground"
          aria-hidden="true"
        >
          HQ
        </div>
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Agent HQ
          </p>
          <p className="text-sm text-muted-foreground">Agent HQ headquarters</p>
        </div>
      </header>
      <section className="space-y-3" aria-labelledby="hq-title">
        <div>
          <h1 id="hq-title" className="text-2xl font-semibold">
            Headquarters
          </h1>
          <p className="text-sm text-muted-foreground">Choose a space to explore.</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/scenes/home"
            className="inline-flex rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            Enter home
          </Link>
          <Link
            href="/scenes/work"
            className="inline-flex rounded-md border border-border px-4 py-2 text-sm font-medium"
          >
            Enter work
          </Link>
        </div>
      </section>
    </main>
  );
}
