import type { NextConfig } from "next";

// The Express API. Same role the Vite dev proxy used to play: keeps /api
// same-origin so no CORS middleware is needed on the backend.
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3000";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${BACKEND_URL}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
