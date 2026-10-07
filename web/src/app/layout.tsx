import type { Metadata } from "next";
import "@fontsource-variable/archivo";
import "@fontsource-variable/roboto";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mafuriko | Nairobi flood risk",
  description: "An explainable flood catastrophe model for Nairobi: hazard, vulnerability, exposure and loss, with every assumption shown.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
