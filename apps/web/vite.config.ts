import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Wilder",
        short_name: "Wilder",
        description: "Hire AI agents and watch them live in a persistent city.",
        display: "standalone",
        orientation: "portrait",
        theme_color: "#05060a",
        background_color: "#05060a",
        start_url: "/",
        icons: [
          {
            src: "/icons/icon-192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "/icons/icon-512.png",
            sizes: "512x512",
            type: "image/png",
          },
          {
            src: "/icons/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // App shell: JS/CSS/HTML plus the display fonts. World assets stream
        // from the gateway at runtime and are cached below instead.
        globPatterns: ["**/*.{js,css,html,woff,woff2}"],
        // The main bundle (~2.5 MB, three.js + game code) must be precached
        // for the installed shell to boot fast; raise workbox's 2 MiB default.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        // Never route API/socket/dev/asset-gateway navigations to the shell.
        navigateFallbackDenylist: [
          /^\/api/,
          /^\/ws/,
          /^\/dev/,
          /^\/lab/,
          /^\/content/,
          /^\/assets/,
        ],
        runtimeCaching: [
          {
            // Baked city map data (geo.bin etc): immutable per deploy.
            urlPattern: /\/citymap\//,
            handler: "CacheFirst",
            options: {
              cacheName: "wilder-citymap",
              expiration: { maxEntries: 32, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          {
            // Textures and other image/binary assets.
            urlPattern: /\.(?:png|jpg|jpeg|webp|bin)$/,
            handler: "CacheFirst",
            options: {
              cacheName: "wilder-textures",
              expiration: { maxEntries: 128, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
    }),
  ],
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
