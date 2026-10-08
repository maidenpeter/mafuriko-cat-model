import type { Metadata } from "next";
import "@fontsource-variable/archivo";
import "@fontsource-variable/roboto";
import "./globals.css";
import { BOOT_SCRIPT } from "@/lib/display";

export const metadata: Metadata = {
  title: "Mafuriko | Nairobi flood risk",
  description: "An explainable flood catastrophe model for Nairobi: hazard, vulnerability, exposure and loss, with every assumption shown.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Browser extensions add their own attributes to these two tags before React starts, which
  // React would otherwise report as a page error. The setting covers these tags' own attributes only.
  // The script in <head> relies on it too: it puts the saved theme and text size on <html>
  // while the page is still being read, so the first thing drawn is already in the reader's choice.
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: BOOT_SCRIPT }} />
      </head>
      <body className="min-h-full" suppressHydrationWarning>{children}</body>
    </html>
  );
}
