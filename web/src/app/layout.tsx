import type { Metadata } from "next";
import "@fontsource-variable/archivo";
import "@fontsource-variable/roboto";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mafuriko | Nairobi flood risk",
  description: "An explainable flood catastrophe model for Nairobi: hazard, vulnerability, exposure and loss, with every assumption shown.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Browser extensions add their own attributes to these two tags before React starts, which
  // React would otherwise report as a page error. The setting covers these tags' own attributes only.
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full" suppressHydrationWarning>{children}</body>
    </html>
  );
}
