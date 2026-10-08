import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
