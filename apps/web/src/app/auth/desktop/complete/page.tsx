import type { Metadata } from "next";

import { DesktopAuthComplete } from "./desktop-auth-complete";

export const metadata: Metadata = {
  title: "Sign-in complete | Agent HQ",
};

export default function DesktopAuthCompletePage() {
  return (
    <main className="auth-shell">
      <section className="auth-panel" aria-labelledby="desktop-auth-complete-title">
        <DesktopAuthComplete />
      </section>
    </main>
  );
}
