import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    // The gateway serves game assets (models/textures/audio) at /assets, so we
    // must NOT emit the client's JS/CSS bundles there too — Vite's default
    // assetsDir "assets" collides with that mount and 404s in production.
    // Emit bundles under /static instead; the SPA fallback serves them.
    assetsDir: "static",
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8080",
      "/dev": "http://localhost:8080",
      "/assets": "http://localhost:8080",
      // Asset Lab dev server (npm run lab)
      "/lab": "http://localhost:8090",
      "/content": "http://localhost:8090",
      "/ws": {
        target: "ws://localhost:8080",
        ws: true,
      },
    },
  },
});
