import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Allow an isolated preview instance to run beside a stale/manual dev server.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
