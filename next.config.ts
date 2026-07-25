import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The native Next.js/Vercel build should type-check only the application.
  // Cloudflare Worker, D1, and Vite entrypoints keep using the main tsconfig.
  typescript: {
    tsconfigPath: "tsconfig.vercel.json",
  },
};

export default nextConfig;
