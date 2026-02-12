import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Coworker Harness Portal",
  description: "Live portal for harness runs, traces, artifacts, and observability.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
