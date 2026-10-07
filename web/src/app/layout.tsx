import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mafuriko — flood loss walkthrough",
  description: "An explainable flood catastrophe model for Nairobi: hazard, vulnerability, exposure and loss, with every assumption shown.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
