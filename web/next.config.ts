import type { NextConfig } from "next";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/** The short git commit the build is made from, or "unknown" when git is absent. The trace block (src/lib/trace.ts) carries it. */
function gitCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

/** The version in package.json, or "unknown" when it cannot be read. */
function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

const nextConfig: NextConfig = {
  // Read once at build time and written into the bundle, so every export says which build made it.
  env: {
    NEXT_PUBLIC_APP_VERSION: gitCommit(),
    NEXT_PUBLIC_APP_PACKAGE_VERSION: packageVersion(),
  },
  experimental: {
    // The dev server's on-disk cache kept serving a stylesheet built from an older
    // globals.css, even across restarts. With it off, every `npm run dev` compiles from
    // the files on disk, so a restart always shows the current styles.
    turbopackFileSystemCacheForDev: false,
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
