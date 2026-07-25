import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produce the minimal Node.js server copied into the Render runtime image.
  output: "standalone",
  // Native Next.js builds should type-check only the application.
  // Cloudflare Worker, D1, and Vite entrypoints keep using the main tsconfig.
  typescript: {
    tsconfigPath: "tsconfig.node.json",
  },
};

export default nextConfig;
