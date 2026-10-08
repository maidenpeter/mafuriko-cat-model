"use client";

/**
 * A script the browser runs while it reads the page, before anything is drawn.
 *
 * The server sends it as runnable JavaScript. In the browser React is told it is plain text:
 * a script React draws itself never runs, and React warns in development when it is handed
 * one that looks runnable. The two differ on purpose, so the mismatch is not reported.
 */
export function InlineScript({ html }: { html: string }) {
  return (
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
