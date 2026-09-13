import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  eslint: {
    // ESLint runs as a separate CI step; don't block builds on linting
    ignoreDuringBuilds: true,
  },
  typescript: {
    // Match the eslint flag above. Codebase has accumulated ~85 type
    // drifts (mostly Prisma JSON-input variance + missing test-runner
    // types) that don't affect runtime; running `tsc --noEmit` in CI
    // catches them without blocking the production build. Flip back
    // to false once those have been swept.
    ignoreBuildErrors: true,
  },
  // Carried over from the now-deleted next.config.js. node-cron pulls in
  // node:* built-ins that webpack chokes on if it tries to bundle them.
  serverExternalPackages: ["node-cron"],
};

export default nextConfig;
