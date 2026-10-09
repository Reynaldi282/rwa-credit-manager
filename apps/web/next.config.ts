import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The shared workspace package ships TypeScript sources.
  transpilePackages: ["@rwa/shared"],
  turbopack: {
    // Monorepo root (npm workspaces), so the linked @rwa/shared package resolves.
    root: path.join(__dirname, "..", ".."),
  },
  poweredByHeader: false,
};

export default nextConfig;
