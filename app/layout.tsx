import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Nomad",
  description: "Research starting maps for mechanical engineering project ideas."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
