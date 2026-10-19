import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  // Native / pdf.js modules must load from node_modules at runtime. Bundling them breaks the
  // @napi-rs/canvas binding used to render scanned pages for the vision model.
  serverExternalPackages: ["@napi-rs/canvas", "unpdf"],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
        ],
      },
    ];
  },
};

export default nextConfig;
